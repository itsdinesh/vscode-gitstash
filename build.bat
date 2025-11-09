@echo off
REM Local build script for Git Stash VSCode Extension

echo Installing dependencies...
call npm install
if %errorlevel% neq 0 exit /b %errorlevel%

echo Running linter...
call npm run lint
if %errorlevel% neq 0 exit /b %errorlevel%

echo Building extension (production mode)...
call npm run build:prod
if %errorlevel% neq 0 exit /b %errorlevel%

echo Packaging extension...
call npm run package
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo Build completed successfully!
echo VSIX package created in the current directory
