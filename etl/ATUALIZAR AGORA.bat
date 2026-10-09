@echo off
rem ===========================================================================
rem  ATUALIZAR AGORA - Reposicoes e Chamados
rem
rem  Faz tres coisas, nesta ordem, e mostra na tela o que aconteceu:
rem    1. traz o ETL mais novo da pasta de rede para C:\BI\REPOSICOES;
rem    2. roda UMA carga agora (WinThor -> Supabase) e deixa o JSON do painel pronto;
rem    3. chama o painel publicado uma vez, para ele buscar o dado novo.
rem
rem  Use na VM SRV-IA, de duplo clique. NAO cria nem muda tarefa agendada: isso e
rem  com o INSTALAR TUDO.bat (uma vez). Pode rodar a qualquer hora e quantas vezes
rem  quiser: se ja houver uma carga rodando (a agendada, por exemplo), a tranca do
rem  banco faz esta esperar de fora em vez de atropelar a outra.
rem
rem  Depois da carga, o painel mostra o dado novo em ate 5 minutos. Para ver na
rem  hora: abra o painel e de Shift+clique no botao Atualizar.
rem ===========================================================================
setlocal EnableExtensions
title Reposicoes e Chamados - atualizar agora
set "AQUI=%~dp0"
pushd "%AQUI%"

set "DEST=C:\BI\REPOSICOES"
if defined REPOSICOES_DESTINO set "DEST=%REPOSICOES_DESTINO%"
set "ERRO="

echo.
echo   REPOSICOES E CHAMADOS - atualizar agora
echo   =======================================
echo.

rem --- so na VM -------------------------------------------------------------
if /i "%COMPUTERNAME%"=="SRV-IA" goto maquina_certa
echo   ATENCAO: esta maquina e a %COMPUTERNAME%, nao a SRV-IA.
echo   A carga do BI roda SO na SRV-IA: duas maquinas com a mesma tarefa
echo   atropelaram as cargas do BI Comercial por uma semana em outubro de 2026.
echo   Uma carga manual daqui e segura (a tranca do banco impede duas ao mesmo
echo   tempo), mas deixa uma copia do ETL em %DEST% nesta maquina.
echo.
set /p RESP="  Digite SIM para continuar assim mesmo: "
if /i not "%RESP%"=="SIM" goto sair
echo.
:maquina_certa

rem --- de onde vem o ETL: pasta de rede (subpastas) ou pasta plana ----------
set "SRC=%AQUI%"
if exist "%AQUI%2 - SISTEMA REPOSICOES\sync_reposicao.py" set "SRC=%AQUI%2 - SISTEMA REPOSICOES\"
set "ENVSRC=%AQUI%ENV"
if exist "%AQUI%1 - CONFIGURACAO\ENV" set "ENVSRC=%AQUI%1 - CONFIGURACAO\ENV"
if not exist "%SRC%sync_reposicao.py" goto sem_etl
if not exist "%ENVSRC%" goto sem_env

rem --- 1. copiar --------------------------------------------------------------
if not exist "%DEST%" mkdir "%DEST%"
if not exist "%DEST%" goto sem_destino
echo   [1/3] Copiando o ETL mais novo para %DEST%
for %%F in (bi_comum.py consultas_reposicao.py sync_reposicao.py diagnostico_reposicao.py executar.py _teste_agendador.py aquecer_painel.py requirements.txt) do call :copiar "%SRC%%%F" "%DEST%\%%F"
call :copiar "%ENVSRC%" "%DEST%\ENV"
if defined ERRO goto falha_copia

rem --- python -----------------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 goto sem_python
python -c "import oracledb, psycopg2, dotenv" >nul 2>nul
if errorlevel 1 goto sem_bibliotecas

rem --- 2. carga ---------------------------------------------------------------
echo.
echo   [2/3] Rodando a carga. Leva de uns 10 segundos a alguns minutos: quem decide e o banco.
echo   ------------------------------------------------------------------------
pushd "%DEST%"
python "%DEST%\executar.py"
set "COD=%ERRORLEVEL%"
popd
echo   ------------------------------------------------------------------------

rem --- 3. aquecer o painel ----------------------------------------------------
echo.
echo   [3/3] Chamando o painel publicado para ele buscar o dado novo
python "%DEST%\aquecer_painel.py"
powershell -NoProfile -Command "if (Test-Path -LiteralPath '%DEST%\aquecer_painel.log') { Get-Content -Tail 1 -LiteralPath '%DEST%\aquecer_painel.log' | ForEach-Object { '  ' + $_ } }"

echo.
echo   O que o log da carga diz (ultimas linhas importantes):
powershell -NoProfile -Command "Get-Content -Tail 80 -LiteralPath '%DEST%\sync_reposicao.log' | Select-String -Pattern 'PAINEL ATUALIZADO|Ja existe uma carga|FALHOU|\[ERROR\]' | Select-Object -Last 4 | ForEach-Object { '  ' + $_.Line }"
echo.
if not "%COD%"=="0" goto carga_falhou
echo   PRONTO. O painel mostra o dado novo em ate 5 minutos.
echo   Para ver agora: abra o painel e de Shift+clique em Atualizar.
goto sair

:carga_falhou
echo   A CARGA TERMINOU COM ERRO (codigo %COD%). Leia as linhas acima.
echo   Se nada apareceu, veja o arquivo falha_inicial.log em %DEST%.
goto sair

:copiar
copy /y %1 %2 >nul 2>nul
if errorlevel 1 (
    echo         NAO consegui copiar %~nx1
    set "ERRO=1"
)
goto :eof

:sem_etl
echo   Nao achei o ETL ao lado deste arquivo. Rode o ATUALIZAR AGORA.bat de dentro da
echo   pasta P:\INTEGRACAO BI\REPOSICOES.
goto sair
:sem_env
echo   Nao achei o arquivo ENV em "1 - CONFIGURACAO". Ele guarda as senhas e e obrigatorio.
goto sair
:sem_destino
echo   Nao consegui criar a pasta %DEST%. Abra este arquivo como administrador.
goto sair
:falha_copia
echo.
echo   Alguns arquivos nao foram copiados. O caso conhecido: arquivo que ficou preso por outro
echo   usuario ou por um programa aberto em %DEST%. Feche o que estiver usando a pasta e rode de novo.
goto sair
:sem_python
echo   Nao encontrei o python.exe. Instale o Python marcando "Add Python to PATH".
goto sair
:sem_bibliotecas
echo   Faltam bibliotecas do ETL. Instale e rode de novo:
echo      python -m pip install -r "%DEST%\requirements.txt"
goto sair

:sair
echo.
popd
pause
endlocal
