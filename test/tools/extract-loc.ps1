# 导出 GServer.TAG.LangLabels（每语言一份 base64 二进制文本包）
$ErrorActionPreference = 'Stop'
$Managed = 'D:\Steam\steamapps\common\Gremlins\Gremlins_Inc_Data\Managed'
$Bin     = 'E:\code\小魔怪\test\bin'
$OutDir  = 'E:\code\小魔怪\test\data\loc'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$onResolve = [System.ResolveEventHandler] {
    param($s, $e)
    $n = (New-Object Reflection.AssemblyName($e.Name)).Name
    foreach ($d in @($Managed, $Bin)) { $p = Join-Path $d "$n.dll"; if (Test-Path $p) { return [Reflection.Assembly]::LoadFrom($p) } }
    return $null
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($onResolve)

$asm = [Reflection.Assembly]::LoadFrom("$Managed\Assembly-CSharp.dll")
$tag = $asm.GetType('GServer.TAG')
"TAG 类型: $($tag.FullName)"

# 触发静态构造
[Runtime.CompilerServices.RuntimeHelpers]::RunClassConstructor($tag.TypeHandle)

$ll = $tag.GetField('LangLabels', [Reflection.BindingFlags]'Public,NonPublic,Static').GetValue($null)
"LangLabels 类型: $($ll.GetType().FullName)  条目: $($ll.Count)"

foreach ($kv in $ll.GetEnumerator()) {
    $lang = $kv.Key.ToString()
    $b64  = $kv.Value
    $bytes = [Convert]::FromBase64String($b64)
    $path = Join-Path $OutDir "$lang.bin"
    [System.IO.File]::WriteAllBytes($path, $bytes)
    "  {0,-22} {1,8} bytes" -f $lang, $bytes.Length
}
"完成: $OutDir"
