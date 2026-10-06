param(
    [switch]$JaElevado,
    [switch]$Conferir,
    [string]$Origem,
    [string]$Destino = "C:\BI\REPOSICOES",
    [string]$Usuario
)

# instalar_e_agendar.ps1
#
# Instala o ETL do sistema REPOSICOES numa pasta local e cria a tarefa agendada
# que alimenta o painel, sem abrir janela nenhuma na hora de rodar.
#
# Como rodar (uma vez so):
#   abra P:\INTEGRACAO BI\REPOSICOES e de duplo clique em "INSTALAR TUDO.bat"
#
# E o mesmo instalador do BI Comercial, so que com uma tarefa em vez de quatro:
# a carga inteira (as rotinas 8352 e 8353 do WinThor) leva uns 10 segundos.
#
# QUAL CONTA VAI RODAR A TAREFA
# O script roda em duas partes: a primeira na sua janela normal, a segunda numa
# janela elevada. Quando o UAC pede credencial de administrador, a janela
# elevada e de OUTRA conta (LUBE\Administrador), e uma tarefa registrada para
# ela nunca roda. Por isso a Parte 1 anota o SEU usuario e passa adiante.
#
# COMO ELE ESCOLHE O MODO DE LOGON
# Registra uma tarefa-cobaia que so escreve um arquivo, dispara, e ve se o
# arquivo aparece. Testa: senha guardada, depois S4U, depois interativo, e fica
# com o primeiro que realmente disparou.
#
# POR QUE INSTALAR EM C:\ E NAO NA PASTA DE REDE
# A tarefa roda numa sessao sem o drive P: mapeado. A pasta de rede continua
# sendo onde voce edita; esta copia local e o que a maquina executa.
#
# SE VOCE MUDAR ALGUM SCRIPT NA PASTA DE REDE, RODE ESTE ARQUIVO DE NOVO.

$ErrorActionPreference = "Stop"

# Caminho de cada arquivo DENTRO da pasta de rede. Na maquina todos caem juntos
# em $Destino, sem subpasta.
$ARQUIVOS = @(
    "1 - CONFIGURACAO\ENV",
    "2 - SISTEMA REPOSICOES\bi_comum.py",
    "2 - SISTEMA REPOSICOES\consultas_reposicao.py",
    "2 - SISTEMA REPOSICOES\sync_reposicao.py",
    "2 - SISTEMA REPOSICOES\diagnostico_reposicao.py",
    "2 - SISTEMA REPOSICOES\executar.py",
    "2 - SISTEMA REPOSICOES\_teste_agendador.py",
    "2 - SISTEMA REPOSICOES\requirements.txt"
)

$NOME_SYNC   = "Reposicoes - Sync"
$NOME_COBAIA = "Reposicoes - teste de agendamento"

function Pausar {
    Write-Host ""
    Write-Host "Pressione ENTER para fechar esta janela..." -ForegroundColor Cyan
    try { Read-Host | Out-Null } catch { Start-Sleep -Seconds 60 }
}

function Traduzir-Resultado {
    param($Codigo)
    switch ($Codigo) {
        0          { "concluiu sem erro" }
        1          { "rodou e terminou com erro - veja o log" }
        2          { "nao chegou a rodar (arquivo nao encontrado ou tarefa recusada)" }
        267009     { "ainda rodando" }
        267011     { "ainda nao rodou" }
        267014     { "foi interrompida" }
        2147942401 { "nao encontrou o pythonw.exe" }
        2147942402 { "nao encontrou o arquivo ou a pasta" }
        2147943726 { "usuario ou senha incorretos" }
        2147943785 { "a conta nao tem o direito de 'logon como tarefa em lote'" }
        2147944309 { "a conta nao tem o direito de 'logon como tarefa em lote'" }
        default    { "codigo $Codigo" }
    }
}

$pastaLocal = $PSScriptRoot
if (-not $pastaLocal) { $pastaLocal = (Get-Location).Path }

$identidade = [Security.Principal.WindowsIdentity]::GetCurrent()
$ehAdmin = (New-Object Security.Principal.WindowsPrincipal($identidade)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# ===========================================================================
# PARTE 1 - sua janela normal: copia os arquivos e anota QUEM e voce
# ===========================================================================

if (-not $JaElevado) {

    # Este script mora em "3 - INSTALACAO"; a raiz da caixa e a pasta de cima.
    if (-not $Origem) {
        $Origem = $pastaLocal
        foreach ($candidata in @($pastaLocal, (Split-Path -Parent $pastaLocal))) {
            if ($candidata -and (Test-Path -LiteralPath (Join-Path $candidata "1 - CONFIGURACAO"))) {
                $Origem = $candidata
                break
            }
        }
    }
    $Usuario = "$env:USERDOMAIN\$env:USERNAME"

    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host " INSTALAR E AGENDAR - Reposicoes e Chamados" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Origem  : $Origem"
    Write-Host "Destino : $Destino"
    Write-Host "Usuario : $Usuario  <- a tarefa vai rodar com esta conta" -ForegroundColor Green
    Write-Host ""

    $faltando = @()
    foreach ($a in $ARQUIVOS) {
        if (-not (Test-Path -LiteralPath (Join-Path $Origem $a))) { $faltando += $a }
    }

    # -Conferir: diz se esta tudo no lugar e para por aqui.
    if ($Conferir) {
        Write-Host "CONFERINDO A PASTA (nada vai ser instalado)" -ForegroundColor Cyan
        Write-Host ""
        foreach ($a in $ARQUIVOS) {
            $existe = Test-Path -LiteralPath (Join-Path $Origem $a)
            $marca = if ($existe) { "  ok   " } else { " FALTA " }
            $cor = if ($existe) { "Green" } else { "Red" }
            Write-Host ($marca + $a) -ForegroundColor $cor
        }
        Write-Host ""
        if ($faltando.Count -eq 0) {
            Write-Host "Esta tudo no lugar. Pode rodar o INSTALAR TUDO.bat." -ForegroundColor Green
        } else {
            Write-Host ("Faltam " + $faltando.Count + " arquivo(s) - veja as linhas em vermelho.") -ForegroundColor Red
        }
        Pausar
        return
    }
    if ($faltando -contains "1 - CONFIGURACAO\ENV") {
        throw ("Nao encontrei o arquivo ENV em " + (Join-Path $Origem "1 - CONFIGURACAO") +
               ". Ele guarda as credenciais e e obrigatorio - comece pelo ENV.example que esta ao lado.")
    }
    if ($faltando.Count -gt 0) {
        throw ("Faltam arquivos em ${Origem}: " + ($faltando -join ", "))
    }

    New-Item -ItemType Directory -Force -Path $Destino | Out-Null
    foreach ($a in $ARQUIVOS) {
        $nome = Split-Path -Leaf $a
        Copy-Item -LiteralPath (Join-Path $Origem $a) -Destination (Join-Path $Destino $nome) -Force
        Write-Host ("  copiado  " + $nome) -ForegroundColor Green
    }
    Write-Host ""
    Write-Host "ETL instalado em $Destino" -ForegroundColor Green

    if (-not $ehAdmin) {
        $euElevado = Join-Path $Destino "instalar_e_agendar.ps1"
        Copy-Item -LiteralPath $PSCommandPath -Destination $euElevado -Force

        $linhaManual = 'powershell -ExecutionPolicy Bypass -NoExit -File "' + $euElevado +
                       '" -JaElevado -Destino "' + $Destino + '" -Usuario "' + $Usuario + '"'

        Write-Host ""
        Write-Host "Agora preciso de administrador para criar a tarefa." -ForegroundColor Yellow
        Write-Host "A janela elevada pode ser de outra conta - tudo bem, ela ja sabe que" -ForegroundColor Yellow
        Write-Host "a tarefa e para o $Usuario." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Se ela nao abrir, cole esta linha num PowerShell como administrador:"
        Write-Host ("   " + $linhaManual) -ForegroundColor White
        Write-Host ""

        try {
            Start-Process powershell.exe -Verb RunAs -ErrorAction Stop -ArgumentList @(
                "-ExecutionPolicy", "Bypass", "-NoExit",
                "-File", "`"$euElevado`"", "-JaElevado",
                "-Destino", "`"$Destino`"", "-Usuario", "`"$Usuario`""
            )
            Write-Host "Janela elevada aberta. Acompanhe por la." -ForegroundColor Green
        } catch {
            Write-Host "Nao consegui elevar: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Use a linha acima." -ForegroundColor Yellow
        }
        Write-Host ""
        exit 0
    }
}

# ===========================================================================
# PARTE 2 - janela elevada: escolhe o modo que funciona e cria a tarefa
# ===========================================================================

try {
    if (-not $ehAdmin) { throw "Continuo sem privilegio de administrador." }
    if (-not $Usuario) { $Usuario = "$env:USERDOMAIN\$env:USERNAME" }
    $euAgora = "$env:USERDOMAIN\$env:USERNAME"

    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host " JANELA ELEVADA - escolhendo o modo e criando a tarefa" -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Pasta de execucao : $Destino"
    Write-Host "Tarefa vai rodar como : $Usuario" -ForegroundColor Green
    if ($euAgora -ne $Usuario) {
        Write-Host "Esta janela e do $euAgora, mas a tarefa NAO vai usar essa conta." -ForegroundColor DarkGray
    }

    $bootstrap = Join-Path $Destino "executar.py"
    $cobaia    = Join-Path $Destino "_teste_agendador.py"
    $alvo      = Join-Path $Destino "sync_reposicao.py"
    foreach ($f in @($bootstrap, $cobaia, $alvo)) {
        if (-not (Test-Path -LiteralPath $f)) {
            throw "Nao encontrei $f. A copia para a pasta local nao aconteceu."
        }
    }

    # --- achar o Python -----------------------------------------------------
    $python = $null
    $c = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($c) { $python = $c.Source }
    if (-not $python) {
        $cw = Get-Command pythonw.exe -ErrorAction SilentlyContinue
        if ($cw) {
            $cand = Join-Path (Split-Path $cw.Source) "python.exe"
            if (Test-Path -LiteralPath $cand) { $python = $cand }
        }
    }
    if (-not $python) {
        throw "Nao encontrei o python.exe. Instale o Python marcando 'Add Python to PATH'."
    }
    $pythonw = Join-Path (Split-Path $python) "pythonw.exe"
    if (-not (Test-Path -LiteralPath $pythonw)) {
        throw "Achei o python.exe em $python mas nao o pythonw.exe ao lado dele."
    }
    Write-Host ""
    Write-Host "Python sem tela   : $pythonw"

    Write-Host ""
    Write-Host "Conferindo as bibliotecas do ETL..."
    $teste = & $python -c "import oracledb, psycopg2, dotenv; print('BIBLIOTECAS OK')" 2>&1
    $saidaTeste = ($teste | Out-String).Trim()
    if ($saidaTeste -match "BIBLIOTECAS OK") {
        Write-Host "  [ok] oracledb, psycopg2 e python-dotenv disponiveis" -ForegroundColor Green
    } else {
        Write-Host "  [X] FALTA BIBLIOTECA." -ForegroundColor Red
        Write-Host $saidaTeste -ForegroundColor Red
        Write-Host ""
        Write-Host "Instale e rode este script de novo:" -ForegroundColor Yellow
        Write-Host ("   " + $python + " -m pip install -r `"" + (Join-Path $Destino "requirements.txt") + "`"") -ForegroundColor White
        Pausar
        exit 1
    }

    $config = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -MultipleInstances IgnoreNew `
        -Hidden

    # --- a senha e opcional: sem ela, pulamos direto para o S4U -------------
    Write-Host ""
    Write-Host "Vai abrir uma caixa pedindo a senha do Windows DE $Usuario." -ForegroundColor Cyan
    Write-Host "Nao e a senha do Administrador - e a sua, a que voce usa para entrar" -ForegroundColor Cyan
    Write-Host "no Windows. Ela permite a tarefa rodar com voce deslogado." -ForegroundColor Cyan
    Write-Host "Se preferir, pode cancelar: eu tento os outros modos." -ForegroundColor DarkGray

    $senha = $null
    try {
        $cred = Get-Credential -Message "Senha do Windows de $Usuario" -UserName $Usuario
        if ($cred) { $senha = $cred.GetNetworkCredential().Password }
    } catch {
        Write-Host "  (caixa de senha cancelada)" -ForegroundColor DarkGray
    }

    # --- registrar uma tarefa num modo -------------------------------------
    function Registrar {
        param($Nome, $Argumento, $Horarios, $Descricao, $Modo)

        $acao = New-ScheduledTaskAction -Execute $pythonw -Argument $Argumento -WorkingDirectory $Destino
        $gatilhos = foreach ($h in $Horarios) { New-ScheduledTaskTrigger -Daily -At (Get-Date $h) }

        if ($Modo -eq "Senha") {
            Register-ScheduledTask -TaskName $Nome -Action $acao -Trigger $gatilhos `
                -Settings $config -User $Usuario -Password $senha `
                -Description $Descricao -Force | Out-Null
        } else {
            $p = New-ScheduledTaskPrincipal -UserId $Usuario -LogonType $Modo -RunLevel Limited
            Register-ScheduledTask -TaskName $Nome -Action $acao -Trigger $gatilhos `
                -Settings $config -Principal $p -Description $Descricao -Force | Out-Null
        }
    }

    # --- a cobaia: prova se o modo realmente dispara um processo ------------
    $marca = Join-Path $Destino "_teste_agendador.txt"

    function Testar-Modo {
        param($Modo)

        if (Test-Path -LiteralPath $marca) { Remove-Item -LiteralPath $marca -Force }

        try {
            Registrar -Nome $NOME_COBAIA -Argumento ('"' + $cobaia + '"') `
                -Horarios @("23:59") -Descricao "Temporaria: testa o agendamento de Reposicoes." -Modo $Modo
        } catch {
            Write-Host ("    registro recusado: " + $_.Exception.Message) -ForegroundColor DarkGray
            return $false
        }

        try { Start-ScheduledTask -TaskName $NOME_COBAIA } catch {
            Write-Host ("    nao consegui disparar: " + $_.Exception.Message) -ForegroundColor DarkGray
            return $false
        }

        $fim = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $fim) {
            Start-Sleep -Seconds 2
            Write-Host -NoNewline "."
            if (Test-Path -LiteralPath $marca) { return $true }
        }
        return $false
    }

    $modos = @(
        @{ nome = "Senha";       rotulo = "senha guardada"; texto = "roda mesmo com voce deslogado" },
        @{ nome = "S4U";         rotulo = "S4U";            texto = "roda mesmo com voce deslogado, sem guardar senha" },
        @{ nome = "Interactive"; rotulo = "interativo";     texto = "roda somente quando voce estiver logado no Windows" }
    )

    Write-Host ""
    Write-Host "Testando os modos de agendamento com uma tarefa-cobaia..." -ForegroundColor Cyan
    Write-Host "(ela so escreve um arquivinho - nao toca no banco)" -ForegroundColor DarkGray

    $modoBom = $null
    foreach ($m in $modos) {
        if ($m.nome -eq "Senha" -and -not $senha) {
            Write-Host ("  - " + $m.rotulo + ": pulado (sem senha)") -ForegroundColor DarkGray
            continue
        }
        Write-Host -NoNewline ("  - " + $m.rotulo + " ")
        if (Testar-Modo -Modo $m.nome) {
            Write-Host " FUNCIONOU" -ForegroundColor Green
            $modoBom = $m
            break
        }
        Write-Host " nao disparou" -ForegroundColor Yellow
    }

    try { Unregister-ScheduledTask -TaskName $NOME_COBAIA -Confirm:$false -ErrorAction SilentlyContinue } catch { }
    if (Test-Path -LiteralPath $marca) { Remove-Item -LiteralPath $marca -Force -ErrorAction SilentlyContinue }

    if (-not $modoBom) {
        Write-Host ""
        Write-Host "NENHUM MODO CONSEGUIU INICIAR UM PROCESSO." -ForegroundColor Red
        Write-Host "Isso ja nao e configuracao de script: a politica desta maquina bloqueia"
        Write-Host "a conta $Usuario de rodar tarefa agendada. Quem resolve e o TI, dando"
        Write-Host "a ela o direito 'Fazer logon como tarefa em lote' na politica local"
        Write-Host "(secpol.msc > Diretivas locais > Atribuicao de direitos de usuario)."
        Pausar
        exit 1
    }

    # --- criar a tarefa de verdade, no modo que passou ----------------------
    # Horarios aos :35, de proposito: o BI COMERCIAL roda aos :45 e o BI COMPRAS
    # aos :50, e dois ETLs na mesma hora disputam o mesmo Oracle. Esta carga e a
    # menor das tres (uns 10 segundos), entao entra antes das outras.
    # Uma carga a cada 2 horas no expediente e uma a noite: o painel mostra o
    # fechamento do dia e as reposicoes que o pessoal lanca ao longo da manha.
    $horarios = @("07:35", "09:35", "11:35", "13:35", "15:35", "17:35", "22:35")

    Write-Host ""
    Write-Host "Criando a tarefa no modo que passou..."

    Registrar -Nome $NOME_SYNC -Argumento ('"' + $bootstrap + '"') `
        -Horarios $horarios -Modo $modoBom.nome `
        -Descricao "Reposicoes e Chamados: rotinas 8352 e 8353 do WinThor para o DATA WAREHOUSE."
    Write-Host "  [ok] $NOME_SYNC" -ForegroundColor Green

    # --- carga de teste de verdade -----------------------------------------
    $log   = Join-Path $Destino "sync_reposicao.log"
    $falha = Join-Path $Destino "falha_inicial.log"
    if (Test-Path -LiteralPath $falha) { Remove-Item -LiteralPath $falha -Force }
    $antes = if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).Length } else { -1 }

    Write-Host ""
    Write-Host "Disparando uma carga de verdade agora (uns 15 segundos)..." -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $NOME_SYNC

    $limite = (Get-Date).AddMinutes(4)
    $viuRodando = $false
    Write-Host -NoNewline "Aguardando"
    while ((Get-Date) -lt $limite) {
        Start-Sleep -Seconds 3
        Write-Host -NoNewline "."
        if (Test-Path -LiteralPath $falha) { break }
        $agora = if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).Length } else { -1 }
        $estado = (Get-ScheduledTask -TaskName $NOME_SYNC).State
        if ($estado -eq "Running") { $viuRodando = $true; continue }
        if ($viuRodando -or $agora -gt $antes) { break }
    }
    Write-Host ""

    $info = Get-ScheduledTask -TaskName $NOME_SYNC | Get-ScheduledTaskInfo
    Write-Host ""
    Write-Host ("Resultado : " + (Traduzir-Resultado $info.LastTaskResult)) -ForegroundColor $(
        if ($info.LastTaskResult -eq 0) { "Green" } else { "Yellow" })

    $depois = if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).Length } else { -1 }

    Write-Host ""
    if ($depois -gt $antes) {
        Write-Host "O PYTHON RODOU - o log cresceu." -ForegroundColor Green
        Write-Host ""
        Get-Content -LiteralPath $log -Tail 14 | ForEach-Object {
            $cor = if ($_ -match "\[ERROR\]|FALHOU|Traceback") { "Red" }
                   elseif ($_ -match "\[WARNING\]") { "Yellow" } else { "Gray" }
            Write-Host "  $_" -ForegroundColor $cor
        }
    } elseif (Test-Path -LiteralPath $falha) {
        Write-Host "O Python comecou e quebrou antes do log. Motivo:" -ForegroundColor Yellow
        Get-Content -LiteralPath $falha | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    } else {
        Write-Host "A tarefa disparou mas a carga nao escreveu no log." -ForegroundColor Yellow
        Write-Host "Confira em $log daqui a alguns minutos - ela pode estar em andamento."
    }

    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  conta que executa   : $Usuario"
    Write-Host "  modo                : $($modoBom.texto)"
    Write-Host "  cargas              : $($horarios -join ', ')"
    Write-Host "  pasta de execucao   : $Destino"
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Para PROVAR que a carga entrou, nao confie no log: consulte" -ForegroundColor Cyan
    Write-Host "reposicao.controle_carga no Supabase (projeto DATA WAREHOUSE)." -ForegroundColor Cyan
    if ($modoBom.nome -eq "Interactive") {
        Write-Host ""
        Write-Host "ATENCAO: neste modo a carga das 22:35 so acontece se" -ForegroundColor Yellow
        Write-Host "voce deixar o Windows logado (pode bloquear a tela, mas nao deslogar)." -ForegroundColor Yellow
    }

} catch {
    Write-Host ""
    Write-Host "FALHOU: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Linha: $($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor DarkGray
}

Pausar
