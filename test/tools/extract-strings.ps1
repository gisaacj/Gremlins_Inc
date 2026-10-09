# 用游戏自身的 GBufferReader 解析语言包, 导出 UIN -> 文本
# 语言包格式: int32 count, 然后 count * (ReadUIN(), ReadString())
#   文本会立即按当前 Language 解析为最终显示文案
$ErrorActionPreference = 'Stop'
$Managed = 'D:\Steam\steamapps\common\Gremlins\Gremlins_Inc_Data\Managed'
$Bin     = 'E:\code\小魔怪\test\bin'
$LocDir  = 'E:\code\小魔怪\test\TextAsset'
$OutDir  = 'E:\code\小魔怪\test\data\strings'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$onResolve = [System.ResolveEventHandler] {
    param($s, $e)
    $n = (New-Object Reflection.AssemblyName($e.Name)).Name
    foreach ($d in @($Managed, $Bin)) { $p = Join-Path $d "$n.dll"; if (Test-Path $p) { return [Reflection.Assembly]::LoadFrom($p) } }
    return $null
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($onResolve)

$asm  = [Reflection.Assembly]::LoadFrom("$Managed\Assembly-CSharp.dll")
$dm   = $asm.GetType('GServer.DM')
$dm.GetMethod('Init').Invoke($null, @()) | Out-Null
$brT  = $asm.GetType('GServer.GBufferReader')

$langs = @('English','Russian','French','German','Spanish','Italian',
           'Brazilian_Portuguese','Polish','Czech','Japanese','Korean','Ukrainian','Chinese')

$summary = @()
foreach ($lang in $langs) {
    $path = Join-Path $LocDir $lang
    if (-not (Test-Path $path)) { Write-Host "缺文件: $lang"; continue }
    $bytes = [System.IO.File]::ReadAllBytes($path)

    $br = [Activator]::CreateInstance($brT, @(, $bytes))
    $count = $br.ReadInt32()
    $outPath = Join-Path $OutDir "$lang.txt"
    $sw = [System.IO.StreamWriter]::new($outPath, $false, [System.Text.UTF8Encoding]::new($false))
    $n = 0
    try {
        for ($i = 0; $i -lt $count; $i++) {
            $uin = $br.ReadUIN()
            $txt = $br.ReadString()
            $sw.WriteLine("$($uin.AsString)`t$txt")
            $n++
        }
    } finally { $sw.Close() }

    $kb = [math]::Round((Get-Item $outPath).Length / 1KB, 1)
    Write-Host ("{0,-20} 条目={1,-6} {2} KB" -f $lang, $n, $kb)
    $summary += [pscustomobject]@{ Lang = $lang; Count = $n; Bytes = $bytes.Length }
}

Write-Host "`n=== 验证: DM 数据的文本键能否在语言包里查到 ==="
$cards = $dm.GetField('ActionCards').GetValue($null)
$png = $asm.GetType('GServer.GBufferReader')
# 取第一张卡的 CaptionID
$list = $cards.GetList()
$c0 = $list[0]
$capId = $c0.CaptionID.AsString
Write-Host "行动卡 a001 的 CaptionID.AsString = $capId"

foreach ($lang in @('English','Chinese')) {
    $txtPath = Join-Path $OutDir "$lang.txt"
    if (-not (Test-Path $txtPath)) { continue }
    $hit = Select-String -Path $txtPath -Pattern "^$capId`t" -SimpleMatch:$false | Select-Object -First 1
    if ($hit) { Write-Host ("  {0,-8} -> {1}" -f $lang, ($hit.Line -split "`t")[1]) }
    else      { Write-Host ("  {0,-8} -> 未命中" -f $lang) }
}
Write-Host "`n输出目录: $OutDir"
