@echo off
rem ===========================================================================
rem  Instala o sistema REPOSICOES na maquina e cria a tarefa agendada.
rem
rem  De duplo clique aqui. Ele pede administrador no meio do caminho - isso e
rem  esperado, e para criar a tarefa no Agendador.
rem
rem  Rode de novo toda vez que mudar alguma coisa nesta pasta de rede: a maquina
rem  nao se atualiza sozinha.
rem ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo   REPOSICOES E CHAMADOS - instalacao
echo   ==================================
echo.
echo   Antes de continuar, confira se o ENV da pasta "1 - CONFIGURACAO" esta
echo   preenchido. E dele que saem as senhas do Oracle e do Supabase.
echo.
pause

powershell -ExecutionPolicy Bypass -File "3 - INSTALACAO\instalar_e_agendar.ps1"
