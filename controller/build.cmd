@echo off
setlocal
cd /d "%~dp0"
cl /nologo /W4 /O2 /GS- /LD input.c /link /NOENTRY /NODEFAULTLIB kernel32.lib /DEF:exports.def /OUT:xinput1_4.dll
