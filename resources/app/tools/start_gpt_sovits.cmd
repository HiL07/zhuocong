@echo off
rem ============================================================
rem  Start local GPT-SoVITS API server (voice cloning for the pet)
rem  Keep this window open. Closing it falls back to edge-tts.
rem
rem  Why the HF_* env vars: huggingface writes its cache to the user
rem  profile by default, which fails in restricted environments and
rem  kills the server at startup. We point it into the project.
rem ============================================================

setlocal
set "GPTDIR=%~dp0..\..\..\Tools\GPT-SoVITS-v4-20250529"
if not exist "%GPTDIR%\api_v2.py" (
  echo [ERROR] GPT-SoVITS not found: %GPTDIR%
  pause
  exit /b 1
)

set "PROJ=%~dp0.."
set "HF_HOME=%PROJ%\.local\hf-home"
set "HUGGINGFACE_HUB_CACHE=%PROJ%\.local\hf-home\hub"
set "TRANSFORMERS_CACHE=%PROJ%\.local\hf-home\hub"
set "HF_HUB_OFFLINE=1"
set "PYTHONIOENCODING=utf-8"

cd /d "%GPTDIR%"
echo Starting GPT-SoVITS API on 127.0.0.1:9880 ...
echo First load takes ~30-60s. Wait for "Uvicorn running on".
echo.
".\runtime\python.exe" "api_v2.py" -a 127.0.0.1 -p 9880 -c "GPT_SoVITS\configs\tts_infer.yaml"

echo.
echo Server exited (exit=%ERRORLEVEL%)
pause
