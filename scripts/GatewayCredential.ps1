# Reads a generic credential from Windows Credential Manager through the Win32 API.
# No modules required; works in Windows PowerShell 5.1 and PowerShell 7.
# Returns a PSCredential, so .UserName and .GetNetworkCredential().Password behave as before.

if (-not ('GatewayCred.Native' -as [type])) {
	Add-Type -Namespace GatewayCred -Name Native -MemberDefinition @'
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr credential);

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
	public int Flags;
	public int Type;
	public string TargetName;
	public string Comment;
	public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
	public int CredentialBlobSize;
	public IntPtr CredentialBlob;
	public int Persist;
	public int AttributeCount;
	public IntPtr Attributes;
	public string TargetAlias;
	public string UserName;
}
'@
}

function Get-GatewayCredential {
	param([Parameter(Mandatory)][string]$Target)

	$ptr = [IntPtr]::Zero
	if (-not [GatewayCred.Native]::CredRead($Target, 1, 0, [ref]$ptr)) {  # 1 = CRED_TYPE_GENERIC
		throw "No stored credential named '$Target' was found."
	}
	try {
		$c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][GatewayCred.Native+CREDENTIAL])
		$secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, [int]($c.CredentialBlobSize / 2))
		[pscredential]::new($c.UserName, (ConvertTo-SecureString $secret -AsPlainText -Force))
	}
	finally {
		[GatewayCred.Native]::CredFree($ptr)
	}
}