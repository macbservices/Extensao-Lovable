// ðŸ”® Lovablex - Background Service Worker

// Importar mÃ³dulos
importScripts("supabase-config.js"); // Supabase Edge Functions
importScripts("security.js"); // Assinatura HMAC
importScripts("license.js"); // Gerenciamento de licenÃ§as

// Listener para abrir extensÃ£o quando clicar no Ã­cone
chrome.action.onClicked.addListener(async (tab) => {
  // Verificar se o navegador suporta sidepanel
  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    try {
      // Tentar abrir como sidepanel (Chrome, Edge, etc)
      await chrome.sidePanel.open({ windowId: tab.windowId });
      console.log('[Extension] Aberto como sidepanel');
    } catch (error) {
      console.error('[Extension] Erro ao abrir sidepanel, abrindo como popup:', error);
      // Se falhar, abrir como popup
      openAsPopup();
    }
  } else {
    // Navegador nÃ£o suporta sidepanel (Opera GX, etc) - abrir como popup
    console.log('[Extension] Sidepanel nÃ£o suportado, abrindo como popup');
    openAsPopup();
  }
});

// FunÃ§Ã£o auxiliar para abrir como popup
async function openAsPopup() {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 400,
      height: 600,
      left: 100,
      top: 100,
      focused: true,
    });
    console.log('[Extension] Popup aberto com sucesso');
  } catch (error) {
    console.error('[Extension] Erro ao abrir popup:', error);
  }
}

// Interceptor de Token
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders.find(
      (header) => header.name.toLowerCase() === "authorization",
    );

    if (authHeader && authHeader.value) {
      const token = authHeader.value.replace("Bearer ", "").trim();
      if (token.length > 20) {
        chrome.storage.local.set({ authToken: token, lovable_token: token });
      }
    }

    // Capturar Project ID da URL da requisiÃ§Ã£o
    const urlMatch = details.url.match(/projects\/([a-f0-9-]+)/);
    if (urlMatch && urlMatch[1]) {
      chrome.storage.local.set({ projectId: urlMatch[1] });
    }
  },
  { urls: ["https://api.lovable.dev/*"] },
  ["requestHeaders"],
);

// ===== SHIELD: Detectar fechamento do painel e remover shield =====

// Executar shield via script tag injection (MAIN world guarantido)
async function executeShieldOnTab(enable) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.lovable.dev/*' });
    console.log('[Shield BG] Tabs encontradas:', tabs.length);
    const shieldFileUrl = chrome.runtime.getURL('shield-inject.js');
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (action, scriptUrl) => {
            document.documentElement.setAttribute('data-shield-action', action ? 'enable' : 'disable');
            var s = document.createElement('script');
            s.src = scriptUrl + '?t=' + Date.now();
            s.onload = function() { s.remove(); };
            s.onerror = function() { console.error('[Shield] Falha ao carregar script'); s.remove(); };
            (document.head || document.documentElement).appendChild(s);
          },
          args: [enable, shieldFileUrl]
        });
        console.log('[Shield BG] executeScript OK na tab', tab.id);
      } catch (e) {
        console.error('[Shield BG] executeScript falhou:', e);
      }
    }
  } catch (e) {
    console.error('[Shield BG] Erro geral:', e);
  }
}

function removeShieldFromAllTabs() {
  executeShieldOnTab(false);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'shield-panel') {
    console.log('[Shield BG] Painel conectado');
    port.onDisconnect.addListener(() => {
      console.log('[Shield BG] Painel desconectado - removendo shield');
      removeShieldFromAllTabs();
    });
  }
});
// ===== FIM SHIELD =====

// Listener de mensagens
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Ping
  if (request.action === "ping") {
    sendResponse("pong");
    return;
  }

  // Abrir popup (desprender)
  if (request.action === "openPopup") {
    (async () => {
      try {
        console.log("Abrindo popup...");

        // Abrir popup imediatamente
        const newWindow = await chrome.windows.create({
          url: chrome.runtime.getURL("popup.html"),
          type: "popup",
          width: 400,
          height: 600,
          left: 100,
          top: 100,
          focused: true,
        });

        console.log("Popup criado:", newWindow.id);
        sendResponse({ success: true, windowId: newWindow.id });
      } catch (error) {
        console.error("Erro ao abrir popup:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  // enhance-prompt agora Ã© chamado diretamente via Edge Function no popup.js

  // Handlers do license.js
  if (request.action === "saveToken") {
    handleSaveToken(request.token).then(sendResponse);
    return true;
  }

  if (request.action === "getToken") {
    handleGetToken().then(sendResponse);
    return true;
  }

  if (request.action === "saveProjectId") {
    handleSaveProjectId(request.projectId).then(sendResponse);
    return true;
  }

  if (request.action === "getProjectId") {
    handleGetProjectId().then(sendResponse);
    return true;
  }

  // getCredits removido - buscado direto da API Lovable no popup.js

  if (request.action === "sendMessage") {
    processMessageSend(request.data).then(sendResponse);
    return true;
  }

  // createNewProject e publish-project agora sÃ£o chamados diretamente via Edge Function/API no popup.js

  if (request.action === "executeShield") {
    executeShieldOnTab(request.enabled).then(() => {
      sendResponse({ success: true });
    }).catch((e) => {
      sendResponse({ success: false, error: e.message });
    });
    return true;
  }

  if (request.action === "checkLicense") {
    handleCheckLicense().then(sendResponse);
    return true;
  }

  if (
    request.action === "licenseActivated" ||
    request.action === "licenseRemoved"
  ) {
    sendResponse({ success: true });
    return true;
  }

  sendResponse({ success: false, error: "AÃ§Ã£o desconhecida" });
  return true;
});

// ===== VALIDAÃ‡ÃƒO DE SESSÃƒO EM TEMPO REAL =====

let sessionCheckInterval = null;

// Verificar se sessÃ£o ainda Ã© vÃ¡lida (detecta acesso simultÃ¢neo em tempo real)
async function checkSessionValidity() {
  try {
    const license = await getSavedLicense();
    
    // SÃ³ validar se tiver licenÃ§a
    if (!license || !license.key) {
      console.log('[Session Check] Sem licenÃ§a, pulando validaÃ§Ã£o');
      return;
    }

    const hwid = await getInstallationId();
    const result = await validateLicenseSupabase(license.key, hwid);

    // Se retornar erro 401 com requiresRelogin ou concurrentAccessDetected
    if (!result.valid && (result.requiresRelogin || result.concurrentAccessDetected)) {
      console.warn('âš ï¸ [Session Check] Acesso simultÃ¢neo detectado! ForÃ§ando logout...');
      
      // Limpar licenÃ§a do storage
      await removeLicense();
      
      // Notificar popup para atualizar UI (se estiver aberto)
      chrome.runtime.sendMessage({
        action: 'forceLogout',
        reason: result.error || 'Acesso simultÃ¢neo detectado! Por seguranÃ§a, vocÃª foi deslogado.'
      }).catch(() => {
        // Popup pode nÃ£o estar aberto, ignorar erro
      });

      // Parar polling de sessÃ£o
      stopSessionCheck();
      
      // Parar tracking de usuÃ¡rios ativos
      stopActiveUsersTracking();
      
      return;
    }

    // Se licenÃ§a expirou ou ficou invÃ¡lida
    if (!result.valid) {
      console.warn('âš ï¸ [Session Check] LicenÃ§a invÃ¡lida detectada');
      
      await removeLicense();
      
      chrome.runtime.sendMessage({
        action: 'forceLogout',
        reason: result.error || 'LicenÃ§a invÃ¡lida ou expirada'
      }).catch(() => {});
      
      stopSessionCheck();
      stopActiveUsersTracking();
    }

  } catch (error) {
    console.error('[Session Check] Erro ao validar sessÃ£o:', error);
  }
}

// Iniciar verificaÃ§Ã£o periÃ³dica de sessÃ£o (a cada 5 minutos)
function startSessionCheck() {
  // Verificar imediatamente
  checkSessionValidity();
  
  // Verificar a cada 5 minutos (cache no validateLicenseSupabase garante eficiÃªncia)
  if (!sessionCheckInterval) {
    sessionCheckInterval = setInterval(checkSessionValidity, 5 * 60 * 1000);
    console.log('[Session Check] ValidaÃ§Ã£o iniciada (a cada 5 minutos)');
  }
}

// Parar verificaÃ§Ã£o de sessÃ£o
function stopSessionCheck() {
  if (sessionCheckInterval) {
    clearInterval(sessionCheckInterval);
    sessionCheckInterval = null;
    console.log('[Session Check] ValidaÃ§Ã£o parada');
  }
}

// ===== RASTREAMENTO DE USUÃRIOS ATIVOS =====

let activeUsersInterval = null;

// Enviar heartbeat para a edge function
async function sendActiveUsersHeartbeat() {
  try {
    const license = await getSavedLicense();
    
    // SÃ³ enviar heartbeat se tiver licenÃ§a vÃ¡lida
    if (!license || !license.key) {
      console.log('[Active Users] Sem licenÃ§a, pulando heartbeat');
      return;
    }

    const response = await fetch(`${SUPABASE_CONFIG.URL}${SUPABASE_CONFIG.FUNCTIONS.ACTIVE_USERS}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_CONFIG.ANON_KEY}`,
        'x-extension-version': chrome.runtime.getManifest().version
      },
      body: JSON.stringify({
        licenseKey: license.key,
        action: 'heartbeat'
      })
    });

    if (!response.ok) {
      console.error('[Active Users] Heartbeat falhou:', response.status);
      return;
    }

    const data = await response.json();
    console.log('[Active Users] Heartbeat enviado. UsuÃ¡rios online:', data.activeUsers);

    // Enviar nÃºmero de usuÃ¡rios ativos para o popup (se estiver aberto)
    chrome.runtime.sendMessage({
      action: 'updateActiveUsers',
      count: data.activeUsers
    }).catch(() => {
      // Popup pode nÃ£o estar aberto, ignorar erro
    });

  } catch (error) {
    console.error('[Active Users] Erro ao enviar heartbeat:', error);
  }
}

// Iniciar rastreamento de usuÃ¡rios ativos
function startActiveUsersTracking() {
  // Enviar heartbeat imediatamente
  sendActiveUsersHeartbeat();

  // Enviar heartbeat a cada 2 minutos
  if (!activeUsersInterval) {
    activeUsersInterval = setInterval(sendActiveUsersHeartbeat, 2 * 60 * 1000);
    console.log('[Active Users] Tracking iniciado (heartbeat a cada 2 minutos)');
  }
}

// Parar rastreamento de usuÃ¡rios ativos
function stopActiveUsersTracking() {
  if (activeUsersInterval) {
    clearInterval(activeUsersInterval);
    activeUsersInterval = null;
    console.log('[Active Users] Tracking parado');
  }
}

// Iniciar tracking quando a extensÃ£o carregar
startActiveUsersTracking();
startSessionCheck();

// Listener para iniciar/parar tracking quando licenÃ§a for ativada/removida
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'licenseActivated') {
    startActiveUsersTracking();
    startSessionCheck();
    sendResponse({ success: true });
    return true;
  }
  
  if (request.action === 'licenseRemoved') {
    stopActiveUsersTracking();
    stopSessionCheck();
    sendResponse({ success: true });
    return true;
  }
});

// ===== FIM RASTREAMENTO DE USUÃRIOS ATIVOS =====
