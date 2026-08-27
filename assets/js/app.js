// ============================================================
// CONFIG — trocar antes de publicar / a cada turma
// ============================================================
var CONFIG = {
  // Link do grupo de WhatsApp pra onde o formulário redireciona após o envio.
  WHATSAPP_GROUP_LINK: "https://chat.whatsapp.com/GiXnrzAWZAn0YgfvDXWz1q",

  // Endpoint que recebe os dados do formulário (n8n, produção).
  FORM_ENDPOINT: "https://n8nwebhook.leticiakratka.shop/webhook/live-semanal",

  // Worker de tracking server-side (Meta CAPI), o mesmo já usado no Caixa Livre e na
  // Consultoria — não é exclusivo dessa página, não precisa criar/trocar por turma.
  META_CAPI_WORKER: "https://lck-tracking-meta-capi.leticiakratka1.workers.dev/funil",
};

// ============================================================
// UTMs — captura todos os parâmetros padrão da URL de chegada, mais os
// click IDs de Meta/Google Ads, que servem pro mesmo propósito de atribuição.
// Salva no sessionStorage assim que a página carrega, e usa esse valor
// salvo como fallback na hora do envio — assim, mesmo que a pessoa
// demore pra preencher o formulário, a origem do clique não se perde.
// ============================================================
var UTM_CAMPOS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid",
];
var UTM_STORAGE_KEY = "webinar_travessia_utms";

function capturarESalvarUTMs() {
  var params = new URLSearchParams(location.search);
  var utms = {};
  var achouAlguma = false;
  UTM_CAMPOS.forEach(function (campo) {
    var valor = params.get(campo);
    utms[campo] = valor || null;
    if (valor) achouAlguma = true;
  });
  if (achouAlguma) {
    try { sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(utms)); } catch (err) { /* privacidade do navegador pode bloquear, tudo bem */ }
  }
  return utms;
}

function obterUTMs() {
  var deAgora = capturarESalvarUTMs();
  var temAlguma = UTM_CAMPOS.some(function (campo) { return deAgora[campo]; });
  if (temAlguma) return deAgora;

  try {
    var salvas = sessionStorage.getItem(UTM_STORAGE_KEY);
    if (salvas) return JSON.parse(salvas);
  } catch (err) { /* privacidade do navegador pode bloquear, tudo bem */ }

  return deAgora;
}

// ============================================================
// TRACKING — mesmo padrão já usado na página da Consultoria e no Caixa Livre.
// Duas frentes que convergem no mesmo Worker (lck-tracking-meta-capi):
//   - "Web": dataLayer.push() com o evento customizado ("lead_live"). Quem escuta
//     é o GTM (GTM-TZ7859WF) — a Leticia/Rualison cria lá um acionador de Evento
//     Personalizado com esse nome exato e pendura nele a tag de Lead do Meta/GA4.
//   - "Server": POST direto pro Worker (não depende de nenhuma tag configurada
//     dentro do GTM, roda direto daqui), que monta o evento com hash server-side
//     e manda pra Meta Conversions API.
// As duas frentes compartilham o mesmo event_id pra Meta deduplicar como 1 evento
// só, em vez de contar 2x (pixel do navegador + servidor).
// ============================================================
function getCookie(nome) {
  var match = document.cookie.match("(?:^|; )" + nome + "=([^;]*)");
  return match ? decodeURIComponent(match[1]) : "";
}

// Normalização pro hash de correspondência avançada do Meta — o próprio Worker faz
// o SHA-256, aqui só limpa o texto (é o que eleva a taxa de correspondência).
function normTexto(v) {
  return (v || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normTelefone(v) {
  var bruto = (v || "").trim();
  var d = bruto.replace(/\D/g, "");
  if (!d) return "";
  if (bruto.charAt(0) === "+") return d;
  if (d.length === 10 || d.length === 11) return "55" + d;
  return d;
}

// ID próprio e persistente (por navegador), útil pra deduplicar com a CAPI a longo prazo.
function externalId() {
  try {
    var id = localStorage.getItem("lck_eid");
    if (!id) {
      id = "lck-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem("lck_eid", id);
    }
    return id;
  } catch (err) {
    return "";
  }
}

function dispararTrackingLead(payload, nomePartes) {
  var leadEventId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : externalId() + "-" + Date.now();

  // Web: avisa o dataLayer que um lead preencheu o formulário. Configurar no GTM um
  // acionador de Evento Personalizado com nome exato "lead_live" e pendurar nele a
  // tag de Lead do Meta Pixel/GA4/Google Ads.
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: "lead_live",
    event_id: leadEventId,
    renda: payload.renda,
    user_data: {
      email: normTexto(payload.email),
      phone: normTelefone(payload.whatsapp),
      first_name: nomePartes[0] || "",
      last_name: nomePartes.slice(1).join(" "),
      country: "br",
      external_id: externalId(),
    },
  });

  // Server: mesmo event_id, direto pro Worker (endpoint /funil, já usado no Caixa
  // Livre e na Consultoria, mesmo formato de payload). Falha silenciosa — não pode
  // travar o redirecionamento do lead se o Worker estiver fora do ar.
  // keepalive: true garante que o navegador termine de enviar essa requisição mesmo
  // que a página já esteja navegando pro WhatsApp logo em seguida (sem isso, em
  // rede mais lenta, o redirect podia cortar o fetch no meio e o evento nunca
  // chegar no servidor — não duplica nada, mas o Lead simplesmente não seria
  // registrado do lado server).
  fetch(CONFIG.META_CAPI_WORKER, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      Object.assign(
        {
          event_name: "Lead",
          event_id: leadEventId,
          url: window.location.href,
          email: payload.email,
          phone: payload.whatsapp,
          first_name: nomePartes[0] || "",
          last_name: nomePartes.slice(1).join(" "),
          fbp: getCookie("_fbp"),
          fbc: getCookie("_fbc"),
          renda: payload.renda,
        },
        obterUTMs()
      )
    ),
  }).catch(function () {});
}

// ============================================================
// FORMULÁRIO — valida, envia (se houver endpoint), dispara tracking e redireciona
// ============================================================
function iniciarFormulario() {
  var form = document.getElementById("apply");
  if (!form) return;

  // Campos obrigatórios (todos, menos o Instagram). O <form novalidate> tira a checagem
  // automática do navegador no submit, então validamos isso aqui na mão.
  var camposObrigatorios = [form.nome, form.email, form.phone, form.renda];

  function limparErro(campo) {
    var grupo = campo.closest(".form-group");
    if (!grupo) return;
    grupo.classList.remove("error");
    var msg = grupo.querySelector(".error-message");
    if (msg) msg.textContent = "";
  }

  function mensagemErro(campo) {
    if (campo.validity.valueMissing) {
      return campo.tagName === "SELECT" ? "Selecione uma opção." : "Preenche esse campo pra continuar.";
    }
    if (campo.validity.typeMismatch) return "Digita um e-mail válido.";
    return campo.validationMessage || "Confere esse campo.";
  }

  function validarFormulario() {
    var primeiroInvalido = null;
    camposObrigatorios.forEach(function (campo) {
      limparErro(campo);
      if (!campo.checkValidity()) {
        var grupo = campo.closest(".form-group");
        if (grupo) {
          grupo.classList.add("error");
          var msg = grupo.querySelector(".error-message");
          if (msg) msg.textContent = mensagemErro(campo);
        }
        if (!primeiroInvalido) primeiroInvalido = campo;
      }
    });
    if (primeiroInvalido) primeiroInvalido.focus();
    return !primeiroInvalido;
  }

  camposObrigatorios.forEach(function (campo) {
    campo.addEventListener("input", function () { limparErro(campo); });
    campo.addEventListener("change", function () { limparErro(campo); });
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    // Honeypot anti-spam: se o campo escondido "website" veio preenchido, é bot.
    if (form.website && form.website.value) return;

    if (!validarFormulario()) return;

    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true; // evita duplo envio/duplo evento de Lead

    var dados = Object.assign(
      {
        nome: form.nome.value.trim(),
        email: form.email.value.trim(),
        whatsapp: form.phone.value.trim(),
        instagram: form.instagram.value.trim(),
        renda: form.renda.options[form.renda.selectedIndex].text,
        page: location.pathname,
        timestamp: new Date().toISOString(),
      },
      obterUTMs()
    );

    if (CONFIG.FORM_ENDPOINT) {
      try {
        await fetch(CONFIG.FORM_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dados),
        });
      } catch (err) {
        console.error("Falha ao enviar inscrição:", err);
        // Segue o redirect mesmo se o envio falhar, pra não travar a pessoa na página.
      }
    }

    var nomePartes = normTexto(dados.nome).split(" ").filter(Boolean);
    dispararTrackingLead(dados, nomePartes);

    window.location.href = CONFIG.WHATSAPP_GROUP_LINK;
  });
}

// ============================================================
// NOTIFICAÇÃO DE INSCRIÇÃO (prova social flutuante)
// PLACEHOLDER: trocar a lista de nomes por algo aprovado pela Leticia antes de publicar.
// ============================================================
function iniciarNotificacao() {
  var el = document.getElementById("sale-notification");
  if (!el) return;
  var nomes = ["Ana", "Carla", "Fernanda", "Juliana", "Patrícia", "Renata"];
  var nomeEl = el.querySelector("[data-sale-name]");
  var avatarEl = el.querySelector("[data-sale-avatar]");

  function mostrar() {
    var nome = nomes[Math.floor(Math.random() * nomes.length)];
    if (nomeEl) nomeEl.textContent = nome;
    if (avatarEl) avatarEl.textContent = nome.charAt(0);
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, 5000);
  }

  setTimeout(mostrar, 6000);
  setInterval(mostrar, 20000);
}

document.addEventListener("DOMContentLoaded", function () {
  capturarESalvarUTMs();
  iniciarFormulario();
  iniciarNotificacao();
});
