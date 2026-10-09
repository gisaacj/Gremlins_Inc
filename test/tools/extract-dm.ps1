# 从 Assembly-CSharp.dll 的 GServer.DM 静态数据中导出权威游戏数据为 JSON
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File extract-dm.ps1
$ErrorActionPreference = 'Stop'

$Managed = 'D:\Steam\steamapps\common\Gremlins\Gremlins_Inc_Data\Managed'
$Bin     = 'E:\code\小魔怪\test\bin'
$OutDir  = 'E:\code\小魔怪\test\data'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# --- 1. 程序集解析 ---
$onResolve = [System.ResolveEventHandler] {
    param($s, $e)
    $n = (New-Object Reflection.AssemblyName($e.Name)).Name
    foreach ($d in @($Managed, $Bin)) {
        $p = Join-Path $d "$n.dll"
        if (Test-Path $p) { return [Reflection.Assembly]::LoadFrom($p) }
    }
    return $null
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($onResolve)

$asm = [Reflection.Assembly]::LoadFrom("$Managed\Assembly-CSharp.dll")
$dm = $asm.GetType('GServer.DM')
$dm.GetMethod('Init').Invoke($null, @()) | Out-Null
Write-Host "DM.Init() OK"

# --- 2. 通用对象图转 JSON ---
$script:Seen = @{}

function Convert-Val {
    param($v, [int]$depth, [int]$maxDepth = 12)

    if ($null -eq $v) { return $null }
    $t = $v.GetType()
    $tn = $t.FullName

    if ($t.IsPrimitive -or $t.IsEnum -or $t -eq [string] -or $t -eq [decimal]) {
        if ($t.IsEnum) { return $v.ToString() }
        return $v
    }
    if ($t -eq [datetime]) { return $v.ToString('o') }

    if ($depth -gt $maxDepth) { return "<maxdepth:$tn>" }

    if (-not $t.IsValueType) {
        $h = [Runtime.CompilerServices.RuntimeHelpers]::GetHashCode($v)
        $key = "$tn#$h"
        if ($script:Seen.ContainsKey($key)) { return "<cycle:$tn>" }
        $script:Seen[$key] = $true
    }

    if ($t.IsArray) {
        $out = @()
        foreach ($item in $v) { $out += ,(Convert-Val $item ($depth + 1) $maxDepth) }
        return ,$out
    }

    if ($v -is [System.Collections.IDictionary]) {
        $o = [ordered]@{}
        foreach ($k in $v.Keys) {
            $kk = if ($k -is [string]) { $k } else { [string]$k }
            $o[$kk] = Convert-Val $v[$k] ($depth + 1) $maxDepth
        }
        return $o
    }

    if ($v -is [System.Collections.IEnumerable]) {
        $out = @()
        foreach ($item in $v) { $out += ,(Convert-Val $item ($depth + 1) $maxDepth) }
        return ,$out
    }

    # GIndexedObjects<T>：本身不存数据，是 DM.Objects.ObjectList 的类型化视图
    if ($t.IsGenericType -and $t.GetGenericTypeDefinition().Name -eq 'GIndexedObjects`1') {
        $m = $t.GetMethod('GetList')
        $list = $m.Invoke($v, @())
        $out = @()
        foreach ($item in $list) { $out += ,(Convert-Val $item ($depth + 1) $maxDepth) }
        return ,$out
    }

    # 兜底：暴露 Items / ObjectList 之类的容器字段
    foreach ($cn in 'Items', 'ObjectList') {
        $cf = $t.GetField($cn, [Reflection.BindingFlags]'Public,NonPublic,Instance')
        if ($cf) { return Convert-Val ($cf.GetValue($v)) ($depth + 1) $maxDepth }
    }

    $o = [ordered]@{}
    $o['__type'] = $t.Name
    foreach ($f in $t.GetFields([Reflection.BindingFlags]'Public,Instance')) {
        if ($f.IsStatic) { continue }
        try { $o[$f.Name] = Convert-Val ($f.GetValue($v)) ($depth + 1) $maxDepth } catch { $o[$f.Name] = "<err>" }
    }
    foreach ($p in $t.GetProperties([Reflection.BindingFlags]'Public,Instance')) {
        if ($p.GetIndexParameters().Count -gt 0) { continue }
        if (-not $p.CanRead) { continue }
        $g = $p.GetGetMethod()
        if ($null -eq $g -or $g.IsStatic) { continue }
        try { $o[$p.Name] = Convert-Val ($p.GetValue($v, $null)) ($depth + 1) $maxDepth } catch { $o[$p.Name] = "<err>" }
    }
    return $o
}

function Dump-Field {
    param([string]$fieldName, [string]$fileName, [int]$maxDepth = 12)
    $f = $dm.GetField($fieldName, [Reflection.BindingFlags]'Public,NonPublic,Static')
    if (-not $f) { Write-Warning "字段不存在: $fieldName"; return }
    $script:Seen = @{}
    $val = Convert-Val ($f.GetValue($null)) 0 $maxDepth
    $path = Join-Path $OutDir "$fileName.json"
    $json = $val | ConvertTo-Json -Depth 100 -Compress
    [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
    $kb = [math]::Round((Get-Item $path).Length / 1KB, 1)
    Write-Host ("{0,-22} -> {1}  ({2} KB)" -f $fieldName, "$fileName.json", $kb)
}

Write-Host "`n=== 导出 ==="
Dump-Field 'Characters'      'characters'       12
Dump-Field 'ActionCards'     'action_cards'     12
Dump-Field 'CellTypes'       'cell_types'       12
Dump-Field 'JailCards'       'jail_cards'       12
Dump-Field 'ChaosCards'      'chaos_cards'      12
Dump-Field 'MisFortuneCards' 'misfortune_cards' 12
Dump-Field 'Dialogs'         'dialogs'          12
Dump-Field 'DialogAnswers'   'dialog_answers'   12
Dump-Field 'TextTags'        'text_tags'        8
Dump-Field 'Maps'            'maps'             20
Dump-Field 'Const'           'const'            10
Dump-Field 'Achives'         'achievements'     8
Dump-Field 'Tutors'          'tutors'           12
Dump-Field 'RareCharges'     'rare_charges'     5

# --- 兜底：导出 DM 的全部其余静态字段（跳过已导出的与 Unity 类型） ---
Write-Host "`n=== 其余静态字段 ==="
$done = @('Characters','ActionCards','CellTypes','JailCards','ChaosCards','MisFortuneCards',
          'Dialogs','DialogAnswers','TextTags','Maps','Const','Achives','Tutors','RareCharges')
$skipPrefix = 'UnityEngine'
foreach ($f in $dm.GetFields([Reflection.BindingFlags]'Public,NonPublic,Static')) {
    if ($done -contains $f.Name) { continue }
    $ft = $f.FieldType
    if ($ft.Namespace -like "$skipPrefix*") { continue }
    if ($ft -eq [Random] -or $ft -eq [IntPtr]) { continue }
    try {
        Dump-Field $f.Name ("misc_" + $f.Name) 8
    } catch {
        Write-Host ("跳过 {0}: {1}" -f $f.Name, $_.Exception.Message)
    }
}

Write-Host "`n=== 额外：角色与格子类型的中文文案 ==="
# 中文语言包经 TAG 反序列化后，同一批对象上的 text 会变成中文。
# 为了把角色技能写进 gamedata，这里先用中文重建一次，再导出一份 characters_zh。
try {
    $tag = $asm.GetType('GServer.TAG')
    $langProp = $tag.GetProperty('Lang')
    $elang = $asm.GetType('GServer.ELang')
    $zh = [Enum]::Parse($elang, 'Chinese')
    $langProp.SetValue($null, $zh)
    Write-Host "  已切换到 Chinese"
    $script:Seen = @{}
    $rawChars = $dm.GetField('Characters').GetValue($null)
    $chars2 = Convert-Val $rawChars 0 12
    $p2 = Join-Path $OutDir 'characters_zh.json'
    [System.IO.File]::WriteAllText($p2, ($chars2 | ConvertTo-Json -Depth 100 -Compress), [System.Text.UTF8Encoding]::new($false))
    Write-Host ("  characters_zh.json {0} KB" -f [math]::Round((Get-Item $p2).Length / 1KB, 1))

    $script:Seen = @{}
    $rawCells = $dm.GetField('CellTypes').GetValue($null)
    $cells2 = Convert-Val $rawCells 0 12
    $p3 = Join-Path $OutDir 'cell_types_zh.json'
    [System.IO.File]::WriteAllText($p3, ($cells2 | ConvertTo-Json -Depth 100 -Compress), [System.Text.UTF8Encoding]::new($false))
    Write-Host ("  cell_types_zh.json {0} KB" -f [math]::Round((Get-Item $p3).Length / 1KB, 1))
} catch {
    Write-Warning "切换中文失败: $($_.Exception.Message)"
}

Write-Host "`n完成，输出目录: $OutDir"
