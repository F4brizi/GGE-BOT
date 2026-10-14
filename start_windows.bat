@echo off
@REM Prevent run as admin issues
cd /D %~dp0

if not exist ".git"\ (
  git init -b main >NUL 2>&1
  git remote add origin https://github.com/darrenthebozz/GGE-BOT.git >NUL 2>&1
  git add . >NUL 2>&1
  git fetch origin >NUL 2>&1
  git reset --hard >NUL 2>&1
  git clean -f -d >NUL 2>&1
  git pull origin main >NUL 2>&1
)

git config --local core.hooksPath .githooks/
git pull origin main

gh auth status >NUL 2>&1
if %ERRORLEVEL% EQU 0 (
  if not exist "plugins-extra" (
    git clone https://github.com/darrenthebozz/GGE-BOT-Extra-Plugins.git plugins-extra
  )
  if exist "plugins-extra" (
    cd "plugins-extra"
    git pull origin main
    cd ..
  )
)

if not exist "website" (
  git clone https://github.com/darrenthebozz/GGE-BOT-Website.git website
)
if exist "website" (
  cd "website"
  git config --local core.hooksPath .githooks/
  git pull origin main
  cd ..
)

echo "Last commit message:"
git show --format=%s -s

if not exist "website\build\index.html" goto rebuild
if exist "website\needsRebuild" goto rebuild
:start
if NOT exist "node_modules\" goto update
if exist "update" goto update

start http://127.0.0.1:3001
node --optimize-for-size --no-warnings main.js
pause
exit
:rebuild
echo. 2> "website\needsRebuild"
cd website
call npm i
call npm run build
if exist "needsRebuild" del /f /q "needsRebuild"
cd ..
if exist "website\needsRebuild" del /f /q "website\needsRebuild"
goto start
:update
echo. 2> "update"
call npm i
del /f /q "update"
goto start