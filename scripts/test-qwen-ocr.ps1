$ErrorActionPreference = 'Stop'

$secureKey = Read-Host '请输入阿里云百炼 API Key（输入内容不会显示）' -AsSecureString
$keyPointer = [IntPtr]::Zero
$exitCode = 1

try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $env:DASHSCOPE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)

    & npm.cmd run test:bailian-models
    $exitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:DASHSCOPE_API_KEY -ErrorAction SilentlyContinue
    if ($keyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
}

exit $exitCode
