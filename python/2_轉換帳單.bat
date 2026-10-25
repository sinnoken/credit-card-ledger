@echo off
cd /d "%~dp0"
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PY=py -3
where py >nul 2>nul || set PY=python
%PY% convert.py
pause
