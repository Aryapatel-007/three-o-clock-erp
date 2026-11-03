; ThreeOClock-Setup.exe: the one file a restaurant downloads and double-clicks.
; Built by box/windows/make-package.sh with Inno Setup 6.3 or later (free):
;   ISCC /DStageDir=<the staged ThreeOClock folder> /DAppVersion=<commit> /DOutputDir=<release> threeoclock-setup.iss
;
; Like any app installer, everything happens in its own window: it asks the restaurant's
; name and the owner's mobile, copies the app to the folder they chose (C:\ThreeOClock is
; suggested; any folder of its own works, spaces included), then runs
; box\windows\install.ps1 -Unattended with no console window, turning the script's
; "@@STEP" lines into the progress bar (Node.js, MongoDB, the server, the sample
; restaurant, the logins file, the desktop icons, nightly updates). A failure shows its
; reason with Retry, so nobody has to start the installer again. Running a newer
; ThreeOClock-Setup.exe over an installed PC updates it and keeps data\ and .env.
;
; The uninstaller lives in data\uninstall, because the nightly updater swaps every
; top-level entry of the app folder except data and .env.

#ifndef StageDir
  #error StageDir is required
#endif
#ifndef AppVersion
  #define AppVersion "0"
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
AppId={{3C0C1A7D-2F4E-4B8A-9E61-7D5A0B3C2E19}
AppName=ThreeOClock
AppVersion={#AppVersion}
AppVerName=ThreeOClock ({#AppVersion})
AppPublisher=ThreeOClock
DefaultDirName=C:\ThreeOClock
; The restaurant chooses the folder on a first install; an update stays where ThreeOClock is.
DisableDirPage=auto
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
UninstallFilesDir={app}\data\uninstall
UninstallDisplayName=ThreeOClock
UninstallDisplayIcon={app}\box\windows\threeoclock.ico
SetupIconFile=threeoclock.ico
; The licence agreement, accepted before anything is installed.
LicenseFile=LICENSE.txt
WizardImageFile=threeoclock-wizard.bmp
WizardSmallImageFile=threeoclock-wizard-small.bmp
OutputDir={#OutputDir}
OutputBaseFilename=ThreeOClock-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
SetupLogging=yes
CloseApplications=no

[Messages]
WelcomeLabel2=This installs ThreeOClock, the restaurant billing system, on this computer.%n%nKeep the computer on the internet until setup finishes. The first time, it downloads the database (about 900 MB), which can take 10 to 30 minutes.
FinishedHeadingLabel=ThreeOClock is ready

[InstallDelete]
; An update replaces the app's own folders whole, so nothing from an older version is left
; behind. Never data\ (snapshots, logs, logins, this uninstaller), .env (the PC's settings
; and keys) or node_modules (install.ps1's npm ci renews it); the database is MongoDB's own,
; outside the app folder.
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\client"
Type: filesandordirs; Name: "{app}\box"
Type: filesandordirs; Name: "{app}\setup"
Type: filesandordirs; Name: "{app}\tools"

[Files]
; Run from the installer's temporary folder before anything is copied (PrepareToInstall).
Source: "stop-server.ps1"; Flags: dontcopy
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\box\windows\open.vbs"""; Description: "Open ThreeOClock now"; Flags: postinstall nowait skipifsilent runasoriginaluser; Check: SetupSucceeded
Filename: "{commondesktop}\ThreeOClock logins.txt"; Description: "Show the logins and passwords"; Flags: postinstall shellexec nowait skipifsilent runasoriginaluser; Check: LoginsSaved

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\box\windows\uninstall.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopThreeOClock"

[UninstallDelete]
Type: files; Name: "{commondesktop}\ThreeOClock.lnk"
Type: files; Name: "{commondesktop}\ThreeOClock - Connect a device.lnk"

[Code]
var
  DetailsPage: TInputQueryWizardPage;
  ProgressPage: TOutputProgressWizardPage;
  StepText, FailReason, Addresses: String;
  StepPercent: Integer;
  Succeeded: Boolean;
  // Decided once at the start: by the end, a new restaurant exists too.
  WasUpdate: Boolean;

function RestaurantAlreadyCreated: Boolean;
begin
  Result := FileExists(AddBackslash(WizardDirValue) + 'data\restaurant-created.txt');
end;

function SetupSucceeded: Boolean;
begin
  Result := Succeeded;
end;

function LoginsSaved: Boolean;
begin
  Result := Succeeded and not WasUpdate and FileExists(ExpandConstant('{commondesktop}\ThreeOClock logins.txt'));
end;

procedure InitializeWizard;
begin
  DetailsPage := CreateInputQueryPage(wpSelectDir,
    'Your restaurant', 'Two details to get started. Both can be changed later in ThreeOClock.',
    'Click Next to keep the answers already filled in.');
  DetailsPage.Add('Restaurant name:', False);
  DetailsPage.Add('Owner''s mobile number (10 digits, used to sign in):', False);
  DetailsPage.Values[0] := 'Three O''Clock Cafe';
  DetailsPage.Values[1] := '9000000001';
  WasUpdate := RestaurantAlreadyCreated;
  if WasUpdate then begin
    // An update: same steps, but nothing to ask and nothing of the restaurant's to lose.
    WizardForm.WelcomeLabel1.Caption := 'Update ThreeOClock';
    WizardForm.WelcomeLabel2.Caption := 'This updates ThreeOClock on this computer to the newest version. There is no need to uninstall the old one.' + #13#10#13#10 +
      'The restaurant''s data stays exactly as it is: menu, tables, bills, staff logins and settings. A backup copy of the database is taken first.' + #13#10#13#10 +
      'ThreeOClock stops for a few minutes while it updates, so do it outside service.';
    WizardForm.WelcomeLabel2.AdjustHeight;
    ProgressPage := CreateOutputProgressPage('Updating ThreeOClock',
      'This takes a few minutes. Keep this computer on the internet.');
  end else
    ProgressPage := CreateOutputProgressPage('Setting up ThreeOClock',
      'This takes 10 to 30 minutes the first time. Keep this computer on the internet.');
end;

// On an update, the running server lets go of the app's files before they are replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if not WasUpdate then Exit;
  ExtractTemporaryFile('stop-server.ps1');
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\stop-server.ps1') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // A PC set up before keeps its restaurant: nothing to ask.
  Result := (PageID = DetailsPage.ID) and WasUpdate;
end;

function IsMobileNumber(const Value: String): Boolean;
var
  I: Integer;
begin
  Result := (Length(Value) = 10) and (Value[1] >= '6') and (Value[1] <= '9');
  for I := 1 to Length(Value) do
    if (Value[I] < '0') or (Value[I] > '9') then Result := False;
end;

// A folder that already holds ThreeOClock: this run is an update there.
function IsThreeOClockFolder(const Dir: String): Boolean;
begin
  Result := FileExists(AddBackslash(Dir) + 'box\windows\install.ps1') or FileExists(AddBackslash(Dir) + 'data\restaurant-created.txt');
end;

function IsEmptyFolder(const Dir: String): Boolean;
var
  Found: TFindRec;
begin
  Result := True;
  if FindFirst(AddBackslash(Dir) + '*', Found) then
  try
    repeat
      if (Found.Name <> '.') and (Found.Name <> '..') then begin
        Result := False;
        Exit;
      end;
    until not FindNext(Found);
  finally
    FindClose(Found);
  end;
end;

// Why a chosen folder cannot hold ThreeOClock, or '' when it can. The server runs from it for
// good, and an update replaces its server, client, box, setup and tools folders whole.
function FolderProblem(const Dir: String): String;
var
  Lower: String;
begin
  Result := '';
  Lower := Lowercase(AddBackslash(Dir));
  if Copy(Lower, 1, 2) = '\\' then
    Result := 'A network folder can go offline. Choose a folder on this computer, for example C:\ThreeOClock.'
  else if Length(RemoveBackslash(Dir)) <= 2 then
    Result := 'Choose a folder of its own, not a whole drive, for example ' + Copy(Dir, 1, 2) + '\ThreeOClock.'
  else if (Pos('\appdata\', Lower) > 0) or (Pos('\temp\', Lower) > 0) or (Pos('\downloads\', Lower) > 0) or (Pos('onedrive', Lower) > 0) then
    Result := 'Downloads, temporary and OneDrive folders can be emptied or moved by Windows. Choose another folder, for example C:\ThreeOClock.'
  else if DirExists(Dir) and not IsEmptyFolder(Dir) and not IsThreeOClockFolder(Dir) then
    Result := 'This folder already has other files in it. Choose an empty or new folder, for example ' + AddBackslash(RemoveBackslash(Dir)) + 'ThreeOClock.';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then begin
    Problem := FolderProblem(WizardDirValue);
    if Problem <> '' then begin
      MsgBox(Problem, mbError, MB_OK);
      Result := False;
      Exit;
    end;
    // The chosen folder may already hold a restaurant: then this run is an update of it.
    WasUpdate := RestaurantAlreadyCreated;
    if WasUpdate then begin
      ProgressPage.Caption := 'Updating ThreeOClock';
      ProgressPage.Description := 'This takes a few minutes. Keep this computer on the internet.';
    end;
  end;
  if CurPageID = DetailsPage.ID then begin
    DetailsPage.Values[0] := Trim(DetailsPage.Values[0]);
    DetailsPage.Values[1] := Trim(DetailsPage.Values[1]);
    if (DetailsPage.Values[0] = '') or (Pos('"', DetailsPage.Values[0]) > 0) then begin
      MsgBox('Type the restaurant''s name, without quote marks.', mbError, MB_OK);
      Result := False;
    end else if not IsMobileNumber(DetailsPage.Values[1]) then begin
      MsgBox('The mobile number must be 10 digits, starting with 6, 7, 8 or 9.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// Only plain text reaches the screen: winget's progress bar is drawn in characters
// that would show as garbage here.
function IsPlain(const S: String): Boolean;
var
  I: Integer;
begin
  Result := Trim(S) <> '';
  for I := 1 to Length(S) do
    if (Ord(S[I]) < 32) or (Ord(S[I]) > 126) then Result := False;
end;

// Every line install.ps1 prints arrives here while it runs.
procedure OnInstallOutput(const S: String; const Error, FirstLine: Boolean);
var
  Rest: String;
  Space: Integer;
begin
  if Pos('@@STEP ', S) = 1 then begin
    Rest := Copy(S, 8, MaxInt);
    Space := Pos(' ', Rest);
    StepPercent := StrToIntDef(Copy(Rest, 1, Space - 1), StepPercent);
    StepText := Copy(Rest, Space + 1, MaxInt);
    ProgressPage.SetText(StepText, '');
    ProgressPage.SetProgress(StepPercent, 100);
  end else if Pos('@@DETAIL ', S) = 1 then
    ProgressPage.SetText(StepText, Copy(S, 10, MaxInt))
  else if Pos('@@FAIL ', S) = 1 then
    FailReason := Copy(S, 8, MaxInt)
  else if Pos('@@ADDRESS ', S) = 1 then
    Addresses := Addresses + '      ' + Copy(S, 11, MaxInt) + #13#10
  else if (Pos('@@', S) <> 1) and IsPlain(S) then
    ProgressPage.SetText(StepText, Copy(Trim(S), 1, 100));
end;

procedure RunThreeOClockSetup;
var
  ResultCode: Integer;
  Params: String;
  Done: Boolean;
begin
  ProgressPage.Show;
  try
    repeat
      FailReason := '';
      Addresses := '';
      StepText := 'Starting...';
      StepPercent := 2;
      ProgressPage.SetText(StepText, '');
      ProgressPage.SetProgress(StepPercent, 100);
      Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\box\windows\install.ps1') + '" -Unattended' +
        ' -RestaurantName "' + DetailsPage.Values[0] + '" -OwnerPhone "' + DetailsPage.Values[1] + '"';
      if not ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, ExpandConstant('{app}'),
        SW_HIDE, ewWaitUntilTerminated, ResultCode, @OnInstallOutput) then
        ResultCode := -1;
      Succeeded := ResultCode = 0;
      Done := Succeeded;
      if not Done then begin
        if FailReason = '' then
          FailReason := 'Setup stopped without saying why (code ' + IntToStr(ResultCode) + ').';
        Done := MsgBox('ThreeOClock setup stopped:' + #13#10#13#10 + FailReason + #13#10#13#10 +
          'Nothing is lost. Click Retry to try again now.' + #13#10 +
          'The full log is in ' + ExpandConstant('{app}') + '\data\logs\install.log.', mbError, MB_RETRYCANCEL) = IDCANCEL;
      end;
    until Done;
    ProgressPage.SetProgress(100, 100);
  finally
    ProgressPage.Hide;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunThreeOClockSetup;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Text: String;
begin
  if CurPageID <> wpFinished then Exit;
  if Succeeded and WasUpdate then
    Text := 'ThreeOClock is updated and running again. The restaurant''s data, logins and settings are as they were.' + #13#10#13#10 +
      'A backup copy of the database from just before the update is in ' + ExpandConstant('{app}') + '\data\snapshots.'
  else if Succeeded then begin
    Text := 'ThreeOClock is installed and running. It starts by itself whenever this computer is switched on.' + #13#10#13#10 +
      'Every login and password (owner, manager, cashier, waiter, kitchen, storekeeper) is in "ThreeOClock logins" on the desktop. Keep it private.';
    if Addresses <> '' then
      Text := Text + #13#10#13#10 + 'Tablets and phones on the same WiFi open:' + #13#10 + Addresses;
  end else
    Text := 'ThreeOClock is not set up yet:' + #13#10 + FailReason + #13#10#13#10 +
      'Run ThreeOClock-Setup.exe again when ready. Nothing is lost.';
  WizardForm.FinishedLabel.Caption := Text;
  WizardForm.FinishedLabel.AdjustHeight;
  // The text grows with what it says, so the Open ThreeOClock and logins boxes move down
  // below it rather than being drawn underneath it.
  WizardForm.RunList.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(16);
  WizardForm.RunList.Height := WizardForm.FinishedPage.ClientHeight - WizardForm.RunList.Top - ScaleY(8);
  if WizardForm.RunList.Height < ScaleY(48) then WizardForm.RunList.Height := ScaleY(48);
end;
