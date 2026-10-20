@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\pip.exe" (
  python -m venv .venv
  if errorlevel 1 goto erro
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto erro
if not exist ".env" copy ".env.example" ".env" >nul
echo.
echo Orbita: http://127.0.0.1:8000
echo Preencha o .env e execute supabase.sql antes de usar o login.
echo Use Ctrl+C para encerrar.
".venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8000
if errorlevel 1 goto erro
exit /b 0
:erro
echo Nao foi possivel iniciar. Confira o Python e sua conexao.
pause
exit /b 1
