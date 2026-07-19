:: =====================================================================
:: File Deletion & Ownership Utility (Link-Safe, Normalized, Continuous)
:: =====================================================================
:: Architecture & Context:
:: This script force-deletes stubborn files/folders by bypassing standard 
:: permissions and removing 'TrustedInstaller' protections.
:: 
:: Upgraded Safety Mechanisms:
:: - Lexical Path Normalization (%%~fi): Resolves relative path syntax such
::   as `..` and `.` without claiming to dereference junctions or symlinks.
:: - Universal Root Protection: Detects if the normalized path lacks a
::   name/extension component (%%~nxi), which mathematically blocks both 
::   local drive roots (C:\) and UNC share roots (\\server\share\).
:: - Trailing Slash Mitigation: Explicitly strips trailing backslashes 
::   from directory paths. This prevents a critical Windows bug where 
::   `rd /s "C:\Link\"` traverses a symlink and wipes the target drive, 
::   whereas `rd /s "C:\Link"` safely unlinks it.
:: - Robust Attribute Parsing: Uses string substitution (!attribs:l=!) to  
::   detect the "l" attribute. This future-proofs against Microsoft altering  
::   attribute string orders and entirely avoids pipe (|) subshell crashes.
:: - Block-Safe Console Logs: Replaced standard parentheses with square 
::   brackets in echo outputs to prevent '... was unexpected' parser crashes.
:: - Same-Drive Progress Filtering: Successful per-item messages emitted by
::   TAKEOWN are hidden only when they refer to the requested target's drive.
::   Diagnostics, summary messages, and paths on other drives remain visible.
::   The FINDSTR expression ends at the drive colon [for example, `K:`]; a
::   trailing backslash next to /C's closing quote is not Windows 8.1-safe.
::   Empty records accompanying filtered TAKEOWN items are also suppressed so
::   recursive operations do not fill the console with blank progress lines.
:: - Target-Type Validation: A directory cannot accidentally be processed by
::   the file branch [or vice versa], preserving the deletion scope selected
::   by the user. All commands remain compatible with Windows 8.1.
:: - Reparse-Ancestor Protection: Rejects targets located underneath a link or
::   junction. Directly selected links can still be safely unlinked, but a link
::   hidden in an ancestor cannot redirect deletion into an unexpected tree.
:: - Pipe-Safe TAKEOWN Calls: Pipelines live in dedicated subroutines and use
::   percent-expanded values, so CMD pipe subprocesses do not depend on delayed
::   expansion being enabled in their independently parsed command lines.
:: =====================================================================

@echo off
setlocal enabledelayedexpansion

:: ---------------------------------------------------------------------
:: 1. Administrative Privilege Check
:: ---------------------------------------------------------------------
:CheckAdmin
:: We suppress output here so cacls doesn't flood the screen or pause execution
"%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system" >nul 2>&1
if '%errorlevel%' NEQ '0' (
    echo [INFO] Requesting administrative privileges...
    :: Pass the path through the environment so PowerShell does not parse any
    :: special characters from the script path as part of its command text.
    set "elevate_script_path=%~f0"
    powershell.exe -NoProfile -Command "Start-Process -FilePath $env:elevate_script_path -Verb RunAs"
    if errorlevel 1 (
        echo [ERROR] Administrative elevation was canceled or could not be started.
        pause
    )
    exit /b
)

:: ---------------------------------------------------------------------
:: 2. Main Application Loop & Sanitization
:: ---------------------------------------------------------------------
:MainMenu
cls
echo ============================================================
echo   ADVANCED FILE ^& DIRECTORY DELETION UTILITY
echo ============================================================
echo.

:: Clear variables to prevent cross-contamination between loop iterations
set "choice="
set "target_type="
set "filepath="
set "confirm="
set "attribs="
set "is_link=false"
set "same_drive_success_pattern="
set "reparse_ancestor_path="
set "reparse_inspection_error_path="

set /p choice="Do you want to delete a (F)ile, a (D)irectory, or (Q)uit? (F/D/Q): "

if /i "!choice!"=="Q" (
    echo [INFO] Exiting program...
    timeout /t 2 /nobreak >nul
    exit /b
) else if /i "!choice!"=="F" (
    set "target_type=file"
    set /p filepath="Enter or drag-and-drop the full path of the FILE: "
) else if /i "!choice!"=="D" (
    set "target_type=directory"
    set /p filepath="Enter or drag-and-drop the full path of the DIRECTORY: "
) else (
    echo [ERROR] Invalid choice. Please press F, D, or Q.
    timeout /t 2 /nobreak >nul
    goto MainMenu
)

:: Clean surrounding quotes from input
if defined filepath set "filepath=!filepath:"=!"

:: Reject entirely empty inputs
if "!filepath!"=="" (
    echo [ERROR] No path provided.
    timeout /t 2 /nobreak >nul
    goto MainMenu
)

:: Reject raw drive letters (e.g., C:) which evaluate to the active working directory
if "!filepath:~-1!"==":" (
    echo.
    echo [ERROR] SAFEGUARD TRIGGERED: Raw drive letters are not allowed.
    pause
    goto MainMenu
)

:: ---------------------------------------------------------------------
:: 3. Path Canonicalization & Critical Trailing Slash Mitigation
:: ---------------------------------------------------------------------
:: Convert to absolute canonical path. This resolves ".." or "." securely.
:: FOR's %%~fi modifier computes a fully qualified lexical path; it does not
:: resolve the destination of a junction or symbolic link.
for %%i in ("!filepath!") do set "filepath=%%~fi"

:: STRIP TRAILING SLASH: 
:: This prevents `rd /s` from traversing inside a junction.
:: We exempt root partitions (e.g., "C:\") because stripping them creates 
:: a raw drive letter, which bypasses the root-protection check.
if "!filepath:~-1!"=="\" (
    if not "!filepath:~-2!"==":\" (
        set "filepath=!filepath:~0,-1!"
    )
)

:: Extract path components to identify if the path is a root directory
for %%i in ("!filepath!") do set "file_name=%%~nxi"

:: If 'name+extension' is empty, the path is the absolute root of a drive (C:\) or UNC share
if "!file_name!"=="" (
    echo.
    echo [ERROR] SAFEGUARD TRIGGERED: You cannot delete a root drive or network share root.
    echo Protected Path: "!filepath!"
    pause
    goto MainMenu
)

:: Verify physical existence using the resolved absolute path
if not exist "!filepath!" (
    echo.
    echo [ERROR] The specified path does not exist: "!filepath!"
    pause
    goto MainMenu
)

:: Verify that the selected operation matches the resolved object. Without
:: this check, DEL given a directory can remove files inside that directory
:: even though the user selected the file-only operation.
for %%i in ("!filepath!") do set "attribs=%%~ai"
if /i "!attribs:~0,1!"=="d" (
    if not "!target_type!"=="directory" (
        echo.
        echo [ERROR] The specified path is a directory. Select D to delete it.
        pause
        goto MainMenu
    )
) else (
    if not "!target_type!"=="file" (
        echo.
        echo [ERROR] The specified path is a file. Select F to delete it.
        pause
        goto MainMenu
    )
)

:: A final item may look like a normal file even when one of its parent path
:: components is a junction to another drive or directory. Reject that case
:: before confirmation and before any permission changes. The target itself is
:: deliberately excluded so a directly selected link can still be unlinked by
:: the existing link-safe branch.
call :FindReparseAncestor
if defined reparse_inspection_error_path (
    echo.
    echo [ERROR] SAFEGUARD TRIGGERED: A parent path could not be inspected.
    echo [ERROR] Unverified ancestor: "!reparse_inspection_error_path!"
    echo [INFO] No ownership, permission, or deletion command was executed.
    pause
    goto MainMenu
)
if defined reparse_ancestor_path (
    echo.
    echo [ERROR] SAFEGUARD TRIGGERED: The target is inside a link or junction.
    echo [ERROR] Reparse-point ancestor: "!reparse_ancestor_path!"
    echo [INFO] Select the link itself, or enter the destination path explicitly.
    pause
    goto MainMenu
)

:: TAKEOWN reports every successfully processed item. Filter only successful
:: item messages for the local drive containing the requested target. Anchoring
:: on SUCCESS preserves errors and system/summary output even when those lines
:: contain the same path. UNC paths have no drive letter and are left unfiltered.
if "!filepath:~1,2!"==":\" (
    set "same_drive_success_pattern=^SUCCESS:.*!filepath:~0,1!:"
)

:: ---------------------------------------------------------------------
:: 4. Safety Confirmation Prompt
:: ---------------------------------------------------------------------
echo.
echo ============================================================
echo [WARNING] You are about to PERMANENTLY delete:
echo "!filepath!"
echo.
echo This action cannot be undone and bypasses system protections.
echo ============================================================
set /p confirm="Are you absolutely sure you want to proceed? (Y/N): "
if /i "!confirm!" NEQ "Y" (
    echo [INFO] Operation canceled by user. Returning to menu...
    timeout /t 2 /nobreak >nul
    goto MainMenu
)

echo.
echo [INFO] Starting deletion process for !target_type!...

:: ---------------------------------------------------------------------
:: 5. Execution & Link-Safe Operations
:: ---------------------------------------------------------------------

:: Attributes were extracted during target-type validation above.

:: Robustly check for Reparse Point 'l' (link/junction) in the attribute string.
:: We use string substitution (!attribs:l=!) to detect 'l' without using pipes (|), 
:: which prevents fatal subshell variable-expansion errors.
if defined attribs (
    if not "!attribs!"=="!attribs:l=!" (
        set "is_link=true"
    )
)

if "!target_type!"=="file" (
    
    if "!is_link!"=="true" (
        echo [INFO] File Symbolic Link detected. Skipping 'takeown' to protect target files.
    ) else (
        echo [INFO] Taking ownership of the file...
        if defined same_drive_success_pattern (
            call :TakeOwnershipOfFileFiltered
        ) else (
            takeown /f "!filepath!"
        )
    )

    echo [INFO] Modifying file permissions...
    icacls "!filepath!" /grant administrators:F /l /c /q 
    icacls "!filepath!" /remove "NT SERVICE\TrustedInstaller" /l /c /q 
    
    :: Force delete file
    del /a /f /q "!filepath!"
    
    if exist "!filepath!" (
        echo [ERROR] Could not delete "!filepath!". It may be locked by an active process.
    ) else (
        echo [SUCCESS] File deleted successfully.
    )

) else if "!target_type!"=="directory" (
    
    if "!is_link!"=="true" (
        echo [INFO] Directory Link/Junction detected. Skipping recursive ownership to protect target.
    ) else (
        :: Fix: Removed inner parentheses around "Safely skipping..." to prevent batch parser block-break bugs
        echo [INFO] Taking ownership of directory contents [Safely skipping external links]...
        if defined same_drive_success_pattern (
            call :TakeOwnershipOfDirectoryFiltered
        ) else (
            takeown /f "!filepath!" /r /d y /skipsl
        )
        
        echo [INFO] Modifying directory permissions...
        icacls "!filepath!" /grant administrators:F /t /l /c /q 
        icacls "!filepath!" /remove "NT SERVICE\TrustedInstaller" /t /l /c /q 
    )
    
    :: Safely removes folders or unlinks junctions natively
    rd /s /q "!filepath!"
    
    if exist "!filepath!" (
        echo [ERROR] Could not fully delete "!filepath!". Some files may be locked by an active process.
    ) else (
        echo [SUCCESS] Directory deleted successfully.
    )
)

:: ---------------------------------------------------------------------
:: 6. Return to Loop
:: ---------------------------------------------------------------------
echo.
echo [INFO] Operation complete. Press any key to return to the main menu.
pause >nul
goto MainMenu

:: ---------------------------------------------------------------------
:: 7. Safety & Output-Filtering Subroutines
:: ---------------------------------------------------------------------

:FindReparseAncestor
:: Input:  filepath is the already normalized target path.
:: Output: reparse_ancestor_path is empty when no parent is a reparse point;
::         otherwise it contains the nearest reparse-point ancestor.
::         reparse_inspection_error_path identifies a parent whose attributes
::         could not be read; callers must treat that as a blocking condition.
:: Rationale: lexical normalization intentionally preserves link components.
:: Walking upward prevents an ancestor junction from silently redirecting the
:: later ownership, ACL, or deletion commands to a different physical tree.
set "reparse_ancestor_path="
set "reparse_inspection_error_path="
for %%i in ("%filepath%") do set "ancestor_path=%%~dpi"

:InspectNextAncestor
:: Keep drive and UNC roots intact while removing separators from other paths.
if "!ancestor_path:~-1!"=="\" if not "!ancestor_path:~-2!"==":\" set "ancestor_path=!ancestor_path:~0,-1!"
set "ancestor_attributes="
for %%i in ("!ancestor_path!") do set "ancestor_attributes=%%~ai"
if not defined ancestor_attributes (
    set "reparse_inspection_error_path=!ancestor_path!"
    exit /b 1
)
if defined ancestor_attributes if not "!ancestor_attributes!"=="!ancestor_attributes:l=!" (
    set "reparse_ancestor_path=!ancestor_path!"
    exit /b 0
)

for %%i in ("!ancestor_path!") do set "parent_ancestor_path=%%~dpi"
if "!parent_ancestor_path:~-1!"=="\" if not "!parent_ancestor_path:~-2!"==":\" set "parent_ancestor_path=!parent_ancestor_path:~0,-1!"
if /i "!parent_ancestor_path!"=="!ancestor_path!" exit /b 0
set "ancestor_path=!parent_ancestor_path!"
goto InspectNextAncestor

:TakeOwnershipOfFileFiltered
:: Percent expansion occurs before CMD divides this pipeline into subprocesses.
:: Consequently the child commands receive concrete values even though they do
:: not inherit this script's delayed-expansion mode.
takeown /f "%filepath%" | "%SYSTEMROOT%\system32\findstr.exe" /v /i /r /c:"%same_drive_success_pattern%" /c:"^$"
if errorlevel 2 echo [WARNING] TAKEOWN ran, but its progress output could not be filtered.
exit /b

:TakeOwnershipOfDirectoryFiltered
:: /SKIPSL retains the established Windows 8.1-compatible behavior of avoiding
:: traversal into links encountered during recursive directory ownership.
takeown /f "%filepath%" /r /d y /skipsl | "%SYSTEMROOT%\system32\findstr.exe" /v /i /r /c:"%same_drive_success_pattern%" /c:"^$"
if errorlevel 2 echo [WARNING] TAKEOWN ran, but its progress output could not be filtered.
exit /b
