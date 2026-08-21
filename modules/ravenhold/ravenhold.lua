-- Tela de login e criacao de conta do Ravenhold.
--
-- Em vez de esconder campo a campo da tela padrao -- o que quebraria a cadeia
-- de ancoras do entergame.otui e deixaria buracos no layout -- montamos uma
-- janela propria e reaproveitamos EnterGame.doLogin(), que le dos widgets
-- originais. Assim herdamos todo o tratamento de protocolo, erros, lista de
-- personagens e o auto-install de assets (entergame.lua:803).
--
-- Tudo passa por pcall: se algo aqui quebrar, a tela padrao continua de pe.
-- Um cliente feio funcionando vale mais que um cliente bonito travado.

Ravenhold = {}

local CONFIG = {
  -- URL COMPLETA do login web service -- nao mais host+porta do login TCP.
  --
  -- O Canary recusa protocolo moderno na porta 7171: em protocollogin.cpp o
  -- ramo "else if (!oldProtocol)" desconecta sempre. Cliente 12+ tem de
  -- autenticar por HTTP, e o Canary nao traz esse servico; quem o serve e a
  -- nossa API (webdeploy/auth/server.js). O cliente ja vai por esse caminho
  -- sozinho quando a porta nao e 7171 (entergame.lua:822), e tryHttpLogin
  -- aceita host no formato https://<host>/<caminho> (entergame.lua:656).
  --
  -- Este valor e so o ponto de partida: init() pergunta o endereco ao
  -- servidor, para o bundle nao carregar o nome do codespace gravado dentro
  -- dele.
  host = 'https://miniature-happiness-6rjq64rj44rc46j7-8080.app.github.dev/login',
  port = 443,
  clientVersion = 1525,
  -- mesma origem: o servidor estatico faz proxy de /api para a API de contas
  api = '/api'
}

local VOCATIONS = {
  { label = 'Knight', key = 'knight' },
  { label = 'Paladin', key = 'paladin' },
  { label = 'Druid', key = 'druid' },
  { label = 'Sorcerer', key = 'sorcerer' }
}

local loginWindow, registerWindow, enterGameWindow
local originalShow, originalHide
local busy = false

local function findEnterGame()
  return g_ui.getRootWidget():recursiveGetChildById('enterGame')
end

local function setStatus(window, text, isError)
  local lbl = window and window:getChildById('lblStatus')
  if not lbl then return end
  lbl:setText(text or '')
  lbl:setColor(isError and '#b06a6a' or '#6a9a6a')
end

function Ravenhold.showLogin()
  if not loginWindow then return end

  -- Ja dentro do jogo a tela de login nao tem o que fazer aqui. O
  -- EnterGame.show original e chamado ao cancelar as caixas de espera
  -- ("Connecting...", lista de personagens), e sem esta guarda a janela
  -- aparece por cima do mundo -- sem botao de fechar, porque a nossa nao tem.
  if g_game.isOnline() then
    loginWindow:hide()
    return
  end

  if enterGameWindow then enterGameWindow:hide() end
  loginWindow:show()
  loginWindow:raise()
  loginWindow:focus()
  local acc = loginWindow:getChildById('edAcc')
  if acc then acc:focus() end
end

function Ravenhold.hideLogin()
  if loginWindow then loginWindow:hide() end
end

function Ravenhold.doLogin()
  if busy then return end
  local acc = loginWindow:getChildById('edAcc'):getText()
  local pass = loginWindow:getChildById('edPass'):getText()

  if acc == '' or pass == '' then
    setStatus(loginWindow, 'Preencha conta e senha.', true)
    return
  end

  local ok, err = pcall(function()
    -- EnterGame.doLogin le destes widgets; preenchemos os que escondemos
    enterGameWindow:getChildById('accountNameTextEdit'):setText(acc)
    enterGameWindow:getChildById('accountPasswordTextEdit'):setText(pass)
    enterGameWindow:getChildById('serverHostTextEdit'):setText(CONFIG.host)
    enterGameWindow:getChildById('serverPortTextEdit'):setText(tostring(CONFIG.port))

    -- O combo recebe as opcoes como NUMERO (entergame.lua:234 faz
    -- addOption(proto)), entao setCurrentOption precisa de numero tambem.
    -- Passando string a comparacao nunca casa, a versao sai 0 e o login
    -- tenta carregar /data/things/0/Tibia.dat.
    local combo = enterGameWindow:getChildById('clientComboBox')
    if combo then
      pcall(function() combo:setCurrentOption(CONFIG.clientVersion, true) end)
      if tonumber(combo:getText()) ~= CONFIG.clientVersion then
        pcall(function() combo:setCurrentOption(tostring(CONFIG.clientVersion), true) end)
      end
      if tonumber(combo:getText()) ~= CONFIG.clientVersion then
        error('versao ' .. CONFIG.clientVersion .. ' nao esta na lista do cliente')
      end
    end

    -- desmarcado = tenta https primeiro (httplogin.cpp:340). Marcado forca
    -- http:// puro, que numa pagina https o navegador bloqueia como conteudo
    -- misto. Como e uma opcao que fica gravada, reafirmamos a cada login.
    local httpBox = enterGameWindow:getChildById('httpLoginBox')
    if httpBox then httpBox:setChecked(false) end

    g_settings.set('host', CONFIG.host)
    g_settings.set('port', CONFIG.port)
    g_settings.set('client-version', CONFIG.clientVersion)

    local remember = loginWindow:getChildById('cbRemember'):isChecked()
    g_settings.set('ravenhold-account', remember and acc or '')
    g_settings.set('ravenhold-remember', remember)
  end)

  if not ok then
    setStatus(loginWindow, 'Falha ao preparar o login: ' .. tostring(err), true)
    return
  end

  setStatus(loginWindow, 'Conectando...', false)
  modules.client_entergame.EnterGame.doLogin()
end

function Ravenhold.showRegister()
  if not registerWindow then return end
  setStatus(registerWindow, '', false)
  registerWindow:show()
  registerWindow:raise()
  registerWindow:focus()
end

function Ravenhold.hideRegister()
  if registerWindow then registerWindow:hide() end
end

function Ravenhold.doRegister()
  if busy then return end

  local acc = registerWindow:getChildById('edAcc'):getText()
  local pass = registerWindow:getChildById('edPass'):getText()
  local pass2 = registerWindow:getChildById('edPass2'):getText()
  local char = registerWindow:getChildById('edChar'):getText()

  local vocLabel = 'Knight'
  local currentOption = registerWindow:getChildById('cbVoc'):getCurrentOption()
  if currentOption and currentOption.text then
    vocLabel = currentOption.text
  end

  if acc == '' or pass == '' or char == '' then
    setStatus(registerWindow, 'Preencha todos os campos.', true)
    return
  end
  if pass ~= pass2 then
    setStatus(registerWindow, 'As senhas nao conferem.', true)
    return
  end

  local vocKey = 'knight'
  for _, v in ipairs(VOCATIONS) do
    if v.label == vocLabel then vocKey = v.key end
  end

  busy = true
  setStatus(registerWindow, 'Criando conta...', false)

  -- o padrao de 2s nao cobre um INSERT no banco
  local oldTimeout = HTTP.timeout
  HTTP.timeout = 15

  local finish = function(msg, isError)
    busy = false
    HTTP.timeout = oldTimeout
    setStatus(registerWindow, msg, isError)
  end

  local ok = pcall(function()
    -- HTTP.post com checkContentLength = false, e nao postJSON: no build WASM
    -- o callback do postJSON nunca dispara e a tela fica presa em
    -- "Criando conta..." mesmo com a conta ja criada no banco. E a mesma
    -- forma que o modulo oficial (client_entergame/createAccount.lua) usa.
    HTTP.post(CONFIG.api .. '/register', {
      account = acc,
      password = pass,
      character = char,
      vocation = vocKey
    }, function(data, err)
      -- com HTTP.post a resposta chega como texto; postJSON e quem decodifica
      if type(data) == 'string' then
        local okJson, decodificado = pcall(function() return json.decode(data) end)
        data = okJson and decodificado or nil
      end
      if err then
        finish('Erro de rede: ' .. tostring(err), true)
        return
      end
      if type(data) ~= 'table' then
        finish('Resposta inesperada da API.', true)
        return
      end
      if data.ok then
        finish('', false)
        Ravenhold.hideRegister()
        loginWindow:getChildById('edAcc'):setText(acc)
        loginWindow:getChildById('edPass'):setText(pass)
        setStatus(loginWindow, 'Conta criada. Clique em Entrar.', false)
      else
        finish(tostring(data.error or 'Nao foi possivel criar a conta.'), true)
      end
    end, false)
  end)

  if not ok then
    finish('HTTP indisponivel neste build.', true)
  end
end

local function setup()
  enterGameWindow = findEnterGame()
  if not enterGameWindow then
    error('janela enterGame nao encontrada')
  end

  loginWindow = g_ui.displayUI('ravenhold')
  registerWindow = g_ui.displayUI('register')
  registerWindow:hide()

  loginWindow:getChildById('lblServer'):setText(
    'Servidor: Ravenhold  |  protocolo ' .. tostring(CONFIG.clientVersion))

  local combo = registerWindow:getChildById('cbVoc')
  for _, v in ipairs(VOCATIONS) do
    combo:addOption(v.label)
  end
  combo:setCurrentIndex(1)

  if g_settings.getBoolean('ravenhold-remember') then
    loginWindow:getChildById('edAcc'):setText(g_settings.get('ravenhold-account') or '')
    loginWindow:getChildById('cbRemember'):setChecked(true)
  end

  -- a tela padrao continua existindo e alimentando o EnterGame; so nao aparece
  local EnterGame = modules.client_entergame.EnterGame
  originalShow = EnterGame.show
  originalHide = EnterGame.hide

  EnterGame.show = function()
    Ravenhold.showLogin()
  end

  EnterGame.hide = function(...)
    pcall(originalHide, ...)
    Ravenhold.hideLogin()
  end

  Ravenhold.showLogin()
end

-- Pergunta ao servidor qual e a URL do login web service.
--
-- Ele responde montando a URL a partir do header Host da nossa propria
-- requisicao, ou seja, o hostname que o navegador realmente usou. Assim o
-- bundle nao carrega o nome do codespace gravado dentro dele: trocou de
-- codespace, o cliente se reajusta sozinho, sem recompilar.
--
-- Se falhar, seguimos com o valor padrao de CONFIG -- vale mais um endereco
-- possivelmente velho que uma tela de login travada esperando resposta.
local function carregarConfigDoServidor()
  -- HTTP.post com checkContentLength = false, e nao HTTP.get: este e o unico
  -- caminho do modulo HTTP cujo callback comprovadamente dispara no build
  -- WASM. O servidor responde a qualquer metodo nesta rota.
  HTTP.post(CONFIG.api .. '/config', {}, function(data, err)
    if err then return end
    if type(data) == 'string' then
      local okJson, decodificado = pcall(function() return json.decode(data) end)
      data = okJson and decodificado or nil
    end
    if type(data) ~= 'table' or type(data.loginUrl) ~= 'string' then return end

    CONFIG.host = data.loginUrl
    if tonumber(data.clientVersion) then
      CONFIG.clientVersion = tonumber(data.clientVersion)
    end
    if loginWindow then
      local lbl = loginWindow:getChildById('lblServer')
      if lbl then
        lbl:setText('Servidor: Ravenhold  |  protocolo ' .. tostring(CONFIG.clientVersion))
      end
    end
  end, false)
end

function init()
  if type(Services) == 'table' and type(Services.ravenhold) == 'table' then
    for k, v in pairs(Services.ravenhold) do
      CONFIG[k] = v
    end
  end

  local ok, err = pcall(setup)
  if ok then
    pcall(carregarConfigDoServidor)
  end
  if not ok then
    g_logger.error('[Ravenhold] tela propria desativada: ' .. tostring(err))
    if loginWindow then pcall(function() loginWindow:destroy() end) end
    if registerWindow then pcall(function() registerWindow:destroy() end) end
    loginWindow, registerWindow = nil, nil
    if enterGameWindow then pcall(function() enterGameWindow:show() end) end
  end
end

function terminate()
  local ok, EnterGame = pcall(function() return modules.client_entergame.EnterGame end)
  if ok and EnterGame then
    if originalShow then EnterGame.show = originalShow end
    if originalHide then EnterGame.hide = originalHide end
  end
  if loginWindow then pcall(function() loginWindow:destroy() end) end
  if registerWindow then pcall(function() registerWindow:destroy() end) end
  loginWindow, registerWindow, enterGameWindow = nil, nil, nil
end
