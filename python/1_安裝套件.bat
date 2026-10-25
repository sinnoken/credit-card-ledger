@echo off
cd /d "%~dp0"
set PY=py -3
where py >nul 2>nul || set PY=python
%PY% --version || (echo Python not found. Run: winget install Python.Python.3.12 & pause & exit /b 1)
%PY% -m pip install --upgrade pip
%PY% -m pip install pdfplumber openpyxl rapidocr-onnxruntime
echo.
echo Done.
pause
