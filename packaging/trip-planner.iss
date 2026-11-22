; Windows installer (Inno Setup 6). Built by the release workflow after `npm run package`:
;   iscc /DAppVersion=3.0.0 packaging\trip-planner.iss   ->   release\Trip-Planner-3.0.0-windows-x64-setup.exe
; Installs for the current user only (no admin rights needed). Trips and settings live in %APPDATA%\Trip Planner
; and are kept when uninstalling.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6A0E4F51-3C2B-4D7A-9E1F-8B5C2D4A7E90}
AppName=Trip Planner
AppVersion={#AppVersion}
AppPublisher=Trip Planner
AppPublisherURL=https://github.com/notetuwu/trip-planner
AppSupportURL=https://github.com/notetuwu/trip-planner/issues
DefaultDirName={localappdata}\Programs\Trip Planner
DefaultGroupName=Trip Planner
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=Trip-Planner-{#AppVersion}-windows-x64-setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\Trip Planner.exe
UninstallDisplayName=Trip Planner
LicenseFile=..\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\release\win\Trip Planner.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Trip Planner"; Filename: "{app}\Trip Planner.exe"
Name: "{autodesktop}\Trip Planner"; Filename: "{app}\Trip Planner.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Trip Planner.exe"; Description: "Start Trip Planner"; Flags: nowait postinstall skipifsilent
; Updates from inside the app run this installer silently: start the new version, without a new window (the open
; window reloads itself).
Filename: "{app}\Trip Planner.exe"; Parameters: "--no-window"; Flags: nowait; Check: WizardSilent

[Code]
// An earlier copy installed for all users (in Program Files, e.g. by running a setup as administrator) can't be
// replaced without admin rights, and Setup would reuse its folder ("Error 5: Access is denied"). Then this copy goes
// to the current user's folder instead, where it can also update itself later. Also for silent in-app updates.
function InProgramFiles(Dir: String): Boolean;
var D: String;
begin
  D := Uppercase(AddBackslash(Dir));
  Result := (Pos(Uppercase(AddBackslash(ExpandConstant('{commonpf64}'))), D) = 1) or (Pos(Uppercase(AddBackslash(ExpandConstant('{commonpf32}'))), D) = 1);
end;

procedure InitializeWizard;
begin
  if (not IsAdmin) and InProgramFiles(WizardForm.DirEdit.Text) then
    WizardForm.DirEdit.Text := ExpandConstant('{localappdata}\Programs\Trip Planner');
end;
