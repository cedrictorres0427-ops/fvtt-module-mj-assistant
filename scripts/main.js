/**
 * MJ Assistant - Muse - Jalon 3.6
 * Correction : cible le USER "Muse" au lieu d'un acteur
 */

const MODULE_ID = "mj-assistant";
let mjAssistantPanel = null;

Hooks.once("init", () => {
  console.log(`[${MODULE_ID}] Init`);

  game.settings.register(MODULE_ID, "backendUrl", {
    name: "URL du backend Python",
    hint: "Adresse du serveur FastAPI local (muse_backend.py).",
    scope: "world", config: true, type: String,
    default: "http://localhost:8000"
  });

  game.settings.register(MODULE_ID, "museUserName", {
    name: "Nom du user Muse",
    hint: "Nom du user Foundry qui sert d'adresse de whisper. À créer dans Manage Players.",
    scope: "world", config: true, type: String,
    default: "Muse"
  });

  game.settings.register(MODULE_ID, "agentEnabled", {
    name: "Muse activée",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "selectedJournalIds", {
    scope: "world", config: false, type: String, default: "[]"
  });

  game.settings.register(MODULE_ID, "museAssignments", {
    scope: "world", config: false, type: String, default: "{}"
  });
});

Hooks.once("ready", () => {
  console.log(`[${MODULE_ID}] Prêt`);
  if (game.user.isGM) {
    ui.notifications.info(`MJ Assistant - Muse chargée.`);
  }
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  controls["mj-assistant"] = {
    name: "mj-assistant",
    title: "MJ Assistant - Muse",
    icon: "fas fa-robot",
    layer: "tokens",
    visible: true,
    activeTool: "open-panel",
    tools: {
      "open-panel": {
        name: "open-panel",
        title: "Ouvrir le panneau Muse",
        icon: "fas fa-comment-dots",
        button: true,
        onClick: () => openMJAssistantPanel()
      }
    }
  };
});

Hooks.on("renderSceneControls", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  const groupButton = root.querySelector('[data-control="mj-assistant"]');
  if (!groupButton) return;
  if (groupButton.dataset.mjAssistantBound === "1") return;
  groupButton.dataset.mjAssistantBound = "1";
  groupButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openMJAssistantPanel();
  }, { capture: true });
});

// ============================================================
// HOOK : createChatMessage - interception des whispers au user Muse
// ============================================================
Hooks.on("createChatMessage", async (message, options, userId) => {
  if (!game.user.isGM) return;
  if (!game.settings.get(MODULE_ID, "agentEnabled")) return;

  const whispers = message.whisper || [];
  if (whispers.length === 0) return;

  const museUserName = game.settings.get(MODULE_ID, "museUserName");
  const museUser = game.users.find(u => u.name === museUserName);
  if (!museUser) return;

  // Le whisper doit contenir le user Muse comme destinataire
  if (!whispers.includes(museUser.id)) return;

  // En v13, message.author est un objet User, pas un ID
  let senderUser = message.author;
  if (typeof senderUser === "string") senderUser = game.users.get(senderUser);
  if (!senderUser && message.user) {
    senderUser = typeof message.user === "string" ? game.users.get(message.user) : message.user;
  }
  if (!senderUser) return;

  // Évite les boucles si on reçoit un message envoyé par le user Muse lui-même
  if (senderUser.id === museUser.id) return;

  console.log(`[${MODULE_ID}] Whisper à Muse de ${senderUser.name}`);
  await handleMuseWhisper(message, senderUser, museUser);
});

function readMuseAssignments() {
  try { return JSON.parse(game.settings.get(MODULE_ID, "museAssignments") || "{}"); }
  catch (e) { return {}; }
}

async function handleMuseWhisper(message, senderUser, museUser) {
  const rawText = message.content || "";
  const cleanText = stripHtml(rawText).trim();
  if (!cleanText) return;

  const isMJ = senderUser.isGM;
  const assignments = readMuseAssignments();

  // Si c'est un PJ qui parle (pas le MJ), on re-diffuse le message original au MJ
  // pour qu'il ait le contexte dans son chat
  if (!isMJ) {
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    if (gmIds.length > 0) {
      const pjName = senderUser.character?.name || senderUser.name;
      ChatMessage.create({
        content: `<div style="border-left:3px solid #888;padding-left:0.6em;opacity:0.85;"><i>[${escapeHtml(pjName)} → Muse]</i><br>${escapeHtml(cleanText)}</div>`,
        whisper: gmIds,
        speaker: { alias: `${pjName} (à sa muse)` }
      });
    }
  }

  // Détection d'une consigne de relais (uniquement pour le MJ)
  // Note : on évite \b qui ne marche pas après les caractères accentués en regex JS.
  // On accepte aussi "à" ou "a" (sans accent) car le MJ tape vite.
  const relayPattern = /^\s*(dit?e?s?\s+[àa]|préviens|signale\s+[àa]|informe|annonce\s+[àa]|transmets?\s+[àa]|fais\s+savoir\s+[àa]|alerte|avertis|notifie)(\s|$|[,;:!?])/i;
  const isRelay = isMJ && relayPattern.test(cleanText);

  let payload;
  let displayMuseName = museUser.name;

  if (isRelay) {
    // Mode MJ relais : liste des PJ AVEC leur muse complète (nom + personnalité)
    const availablePjs = game.actors
      .filter(a => a.type === "character")
      .map(a => {
        const m = assignments[a.id];
        return {
          name: a.name,
          id: a.id,
          muse_name: m?.name || null,
          muse_personality: m?.personality || null
        };
      });

    payload = {
      mode: "mj",
      speaker_name: senderUser.name,
      message: cleanText,
      available_pjs: availablePjs,
      journals: readSelectedJournals(null)  // null = mode MJ, tout accessible
    };
  } else if (isMJ) {
    // Mode MJ question perso : le MJ pose une question directement, pas de fiche PJ,
    // on lui donne accès aux journaux seulement
    payload = {
      mode: "pj",
      speaker_name: senderUser.name,
      message: cleanText,
      pj_context: {
        name: senderUser.name,
        biographie: { concept: "Maître du Jeu - administrateur de la table" },
        morphe: {},
        aptitudes: [],
        competences: [],
        stats: {},
        notes: ""
      },
      muse_name: "Assistant MJ",
      muse_personality: "Tu es l'assistant personnel du MJ. Ton ton est professionnel, concis, factuel. Tu ne joues pas de rôle, tu ne prétends pas être une muse Eclipse Phase, tu es un outil technique qui donne des informations basées sur les journaux de campagne.",
      journals: readSelectedJournals(null)  // MJ = accès total
    };
    displayMuseName = "Assistant MJ";
  } else {
    // Mode PJ normal
    const pj = senderUser.character;
    if (!pj) {
      ChatMessage.create({
        content: `<p><i>La Muse ne peut pas vous répondre : aucun personnage n'est lié à votre compte.</i></p>`,
        whisper: [senderUser.id, ...game.users.filter(u => u.isGM).map(u => u.id)],
        speaker: { alias: museUser.name }
      });
      return;
    }

    const muse = assignments[pj.id];
    if (muse?.name) displayMuseName = muse.name;

    payload = {
      mode: "pj",
      speaker_name: senderUser.name,
      message: cleanText,
      pj_context: readPjSheet(pj),
      muse_name: muse?.name || null,
      muse_personality: muse?.personality || null,
      journals: readSelectedJournals(pj, cleanText)  // Filtre perso/général automatiquement
    };
  }

  const thinkingMsg = await ChatMessage.create({
    content: `<p><i>${displayMuseName} réfléchit...</i></p>`,
    whisper: [senderUser.id, ...game.users.filter(u => u.isGM).map(u => u.id)],
    speaker: { alias: displayMuseName }
  });

  let response;
  try {
    const backendUrl = game.settings.get(MODULE_ID, "backendUrl");
    const r = await fetch(`${backendUrl}/muse/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    response = await r.json();
  } catch (e) {
    await thinkingMsg.delete();
    ChatMessage.create({
      content: `<p><i>Erreur de communication avec la Muse : ${e.message}</i></p>`,
      whisper: [senderUser.id, ...game.users.filter(u => u.isGM).map(u => u.id)],
      speaker: { alias: displayMuseName }
    });
    return;
  }

  await thinkingMsg.delete();

  if (!response.success) {
    ChatMessage.create({
      content: `<p><i>${displayMuseName} : ${response.error || 'erreur inconnue'}</i></p>`,
      whisper: [senderUser.id, ...game.users.filter(u => u.isGM).map(u => u.id)],
      speaker: { alias: displayMuseName }
    });
    return;
  }

  if (isMJ) {
    const targets = response.targets || [];
    if (targets.length === 0) {
      ChatMessage.create({
        content: `<p><i>Aucun destinataire identifié dans ta consigne.</i></p>`,
        whisper: [senderUser.id],
        speaker: { alias: museUser.name }
      });
      return;
    }

    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);

    for (const t of targets) {
      const targetPj = game.actors.find(a => a.name === t.target_pj_name);
      if (!targetPj) {
        ChatMessage.create({
          content: `<p><i>PJ "${t.target_pj_name}" introuvable.</i></p>`,
          whisper: [senderUser.id],
          speaker: { alias: museUser.name }
        });
        continue;
      }

      const targetUsers = game.users.filter(u => targetPj.testUserPermission(u, "OWNER") && !u.isGM);
      const recipients = [...targetUsers.map(u => u.id), ...gmIds];
      const targetMuseName = t.target_muse_name || museUser.name;

      await ChatMessage.create({
        content: `<div class="mj-muse-reply"><p>${escapeHtml(t.message)}</p></div>`,
        whisper: recipients,
        speaker: { alias: targetMuseName },
        flavor: `À ${targetPj.name}`
      });
    }
  } else {
    const recipients = [senderUser.id, ...game.users.filter(u => u.isGM).map(u => u.id)];
    ChatMessage.create({
      content: `<div class="mj-muse-reply"><p>${escapeHtml(response.text)}</p></div>`,
      whisper: recipients,
      speaker: { alias: displayMuseName }
    });
  }
}

/**
 * Lit les journaux sélectionnés en appliquant les règles d'accès de la Muse.
 *
 * Règles d'accès par page :
 * - Journal dont le nom = nom d'un PJ → journal personnel de ce PJ.
 *     * Si le PJ demandeur EST ce PJ → toutes les pages lui sont accessibles.
 *     * Sinon → seule la page "Info publique" est accessible.
 * - Tout autre journal sélectionné → accessible à toutes les muses, toutes pages.
 * - Mode MJ relais (requestingPj = null) → tout accessible.
 *
 * Filtrage par type de question (si message fourni) :
 * - Question personnelle (je, moi, mon, suis-je...) → uniquement le journal du PJ, pas les généraux.
 * - Question générale → tous les journaux accessibles.
 * - Pas de message fourni → tous les journaux accessibles.
 *
 * @param {Actor|null} requestingPj - Le PJ qui pose la question (null = mode MJ relais)
 * @param {string} [message=""] - Le message du PJ, pour déterminer si c'est une question perso
 * @returns {Array<{name: string, content: string}>}
 */
function readSelectedJournals(requestingPj = null, message = "") {
  let ids;
  try { ids = JSON.parse(game.settings.get(MODULE_ID, "selectedJournalIds") || "[]"); }
  catch (e) { ids = []; }
  if (!Array.isArray(ids)) ids = [];

  // Noms de PJ dans le monde (insensible à la casse)
  const pjNamesLower = new Map(
    game.actors
      .filter(a => a.type === "character")
      .map(a => [a.name.toLowerCase(), a.name])
  );

  const PUBLIC_PAGE = "Info publique";

  // Détection question personnelle vs générale
  const personalPatterns = [
    /\bqui suis[\s-]?je\b/i,
    /\bque suis[\s-]?je\b/i,
    /\bque fais[\s-]?je\b/i,
    /\bqu.est.ce que je\b/i,
    /\bmon (passé|histoire|historique|morphe|identité|nom|concept|âge|faction)\b/i,
    /\bma (bio|biographie|faction|mission|compétence|valeur)\b/i,
    /\bmes (compétences|aptitudes|stats|motivations|notes)\b/i,
    /\bma valeur en\b/i,
    /\bmon score (de|en)\b/i,
    /\bparle[\s-]moi de (moi|mon|ma|mes)\b/i,
    /\bsur moi\b/i,
    /\bme (concerne|décri)/i,
    /\ben train de (faire|préparer|travailler)\b/i,
  ];
  const isPersonal = message && requestingPj && personalPatterns.some(p => p.test(message));

  const result = [];

  for (const id of ids) {
    const journal = game.journal.get(id);
    if (!journal) continue;

    const jname = journal.name;
    const jnameLower = jname.toLowerCase();
    const isPjJournal = pjNamesLower.has(jnameLower);
    const isOwnJournal = requestingPj && jnameLower === requestingPj.name.toLowerCase();
    const isMJMode = !requestingPj;

    // Si question personnelle, on skip les journaux qui ne sont pas le journal du PJ
    if (isPersonal && !isOwnJournal) continue;

    let content = "";
    for (const page of journal.pages.contents) {
      const pname = page.name;
      const ptext = stripHtml(page.text?.content || "");
      if (!ptext) continue;

      let allowed = false;
      if (isMJMode) {
        allowed = true;
      } else if (isPjJournal) {
        if (isOwnJournal) {
          allowed = true;
        } else {
          allowed = (pname === PUBLIC_PAGE);
        }
      } else {
        allowed = true;
      }

      if (allowed) {
        content += `\n[Page : ${pname}]\n${ptext}\n`;
      }
    }

    if (content.trim()) {
      result.push({ name: jname, content: content.trim() });
    }
  }

  return result;
}

function readPjSheet(actor) {
  if (!actor) return null;
  const sys = actor.system || {};
  const aptAbrs = { cog: "COG", coo: "COO", int: "INT", ref: "RÉF", ast: "AST", som: "SOM", vol: "VOL" };

  const aptitudes = [];
  for (const [key, apt] of Object.entries(sys.aptitudes || {})) {
    aptitudes.push({
      key,
      abr: apt.abr || aptAbrs[key] || key.toUpperCase(),
      total: (apt.base || 0) + (apt.morphe || 0)
    });
  }

  const competences = [];
  const allComp = { ...(sys.competences_actives || {}), ...(sys.competences_connaissances || {}) };
  for (const [key, c] of Object.entries(allComp)) {
    if (!c.nom) continue;
    const aptKey = c.aptitude || "cog";
    const apt = sys.aptitudes?.[aptKey];
    const aptBase = (apt?.base || 0) + (apt?.morphe || 0);
    const valeur = c.base || 0;
    const total = aptBase + valeur + (c.bonus_morphe || 0) + (c.bonus_hist || 0);
    if (total > 0) {
      competences.push({ nom: c.nom, aptitude: aptKey, valeur, total, specialisation: c.specialisation || "" });
    }
  }

  for (const item of actor.items.filter(i => i.type === "competence")) {
    const aptKey = item.system.aptitude || "cog";
    const apt = sys.aptitudes?.[aptKey];
    const aptBase = (apt?.base || 0) + (apt?.morphe || 0);
    const valeur = item.system.valeur || 0;
    const total = aptBase + valeur;
    if (total > 0) {
      competences.push({ nom: item.name, aptitude: aptKey, valeur, total, specialisation: item.system.specialisation || "" });
    }
  }

  competences.sort((a, b) => b.total - a.total);

  return {
    name: actor.name,
    biographie: {
      faction: sys.biographie?.faction || "",
      concept: sys.biographie?.concept || "",
      identite: sys.biographie?.identite || "",
      age: sys.biographie?.age || "",
      motivations: sys.biographie?.motivations || "",
      historique: sys.biographie?.historique || "",
      biographie: sys.biographie?.biographie || "",
      notes: sys.biographie?.notes || ""
    },
    morphe: {
      nom: sys.morphe_actuel?.nom || "",
      type: sys.morphe_actuel?.type || "",
      description: sys.morphe_actuel?.description || "",
      implants: sys.morphe_actuel?.implants || "",
      avantages: sys.morphe_actuel?.avantages || ""
    },
    aptitudes, competences,
    stats: { end: sys.stats?.end?.value || 0, luc: sys.stats?.luc?.value || 0 },
    notes: sys.biographie?.notes || ""
  };
}

function stripHtml(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function openMJAssistantPanel() {
  if (!mjAssistantPanel) mjAssistantPanel = new MJAssistantPanel();
  mjAssistantPanel.render(true);
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class MJAssistantPanel extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "mj-assistant-panel",
    classes: ["mj-assistant"],
    tag: "div",
    window: {
      title: "MJ Assistant - Muse",
      icon: "fas fa-robot",
      resizable: true,
      minimizable: true
    },
    position: { width: 520, height: 750 },
    actions: {
      selectJournals: MJAssistantPanel.prototype._onSelectJournals,
      testBackend: MJAssistantPanel.prototype._onTestBackend,
      toggleEnabled: MJAssistantPanel.prototype._onToggleEnabled,
      editMuse: MJAssistantPanel.prototype._onEditMuse,
      clearMuse: MJAssistantPanel.prototype._onClearMuse
    }
  };

  static PARTS = {
    main: { template: "modules/mj-assistant/templates/panel.hbs" }
  };

  async _prepareContext(options) {
    const museUserName = game.settings.get(MODULE_ID, "museUserName");
    const museUser = game.users.find(u => u.name === museUserName);

    let selectedIds = [];
    try { selectedIds = JSON.parse(game.settings.get(MODULE_ID, "selectedJournalIds") || "[]"); }
    catch (e) { selectedIds = []; }

    const selectedJournals = selectedIds
      .map(id => game.journal.get(id))
      .filter(j => j)
      .map(j => ({ id: j.id, name: j.name, pageCount: j.pages.size }));

    const assignments = readMuseAssignments();
    const pjList = game.actors
      .filter(a => a.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(a => {
        const m = assignments[a.id];
        return {
          id: a.id,
          name: a.name,
          img: a.img,
          museName: m?.name || "",
          musePersonality: m?.personality || "",
          hasMuse: !!(m?.name)
        };
      });

    return {
      moduleId: MODULE_ID,
      enabled: game.settings.get(MODULE_ID, "agentEnabled"),
      backendUrl: game.settings.get(MODULE_ID, "backendUrl"),
      museUserName,
      museUserFound: !!museUser,
      selectedJournals,
      selectedJournalsCount: selectedJournals.length,
      pjList,
      pjCount: pjList.length
    };
  }

  async _onSelectJournals(event, target) {
    const allJournals = game.journal.contents.map(j => ({ id: j.id, name: j.name, pageCount: j.pages.size }));
    if (allJournals.length === 0) {
      ui.notifications.warn("Aucun Journal Entry dans ce monde.");
      return;
    }

    let selectedIds = [];
    try { selectedIds = JSON.parse(game.settings.get(MODULE_ID, "selectedJournalIds") || "[]"); }
    catch (e) { selectedIds = []; }

    const checkboxes = allJournals.map(j => {
      const checked = selectedIds.includes(j.id) ? "checked" : "";
      return `<div style="margin: 4px 0;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
          <input type="checkbox" data-id="${j.id}" ${checked} />
          <span><b>${escapeHtml(j.name)}</b> <small style="opacity:0.6">(${j.pageCount} page(s))</small></span>
        </label>
      </div>`;
    }).join("");

    const content = `
      <form>
        <p style="margin: 0 0 10px 0; font-size: 0.9em; opacity: 0.8;">Sélectionne les journaux que les Muses pourront consulter.</p>
        <div style="max-height: 400px; overflow-y: auto; border: 1px solid #555; padding: 8px; border-radius: 4px;">${checkboxes}</div>
      </form>
    `;

    const self = this;
    new foundry.applications.api.DialogV2({
      window: { title: "Sélection des journaux" },
      content,
      buttons: [
        {
          action: "save", label: "Enregistrer", icon: "fas fa-save", default: true,
          callback: async (event, button, dialog) => {
            const root = dialog.element;
            const checks = root.querySelectorAll('input[type="checkbox"]');
            const newIds = [];
            checks.forEach(c => { if (c.checked) newIds.push(c.dataset.id); });
            await game.settings.set(MODULE_ID, "selectedJournalIds", JSON.stringify(newIds));
            ui.notifications.info(`${newIds.length} journal(aux) sélectionné(s).`);
            self.render(false);
          }
        },
        { action: "cancel", label: "Annuler", icon: "fas fa-times" }
      ]
    }).render(true);
  }

  async _onEditMuse(event, target) {
    const pjId = target.dataset.pjId;
    const pj = game.actors.get(pjId);
    if (!pj) return;

    const assignments = readMuseAssignments();
    const current = assignments[pjId] || { name: "", personality: "" };

    const content = `
      <form>
        <p style="margin: 0 0 10px 0; font-size: 0.9em;">Configure la Muse de <b>${escapeHtml(pj.name)}</b>.</p>
        <div style="margin-bottom: 10px;">
          <label style="display: block; font-weight: bold; margin-bottom: 4px;">Nom de la Muse</label>
          <input type="text" name="muse-name" value="${escapeHtml(current.name)}" placeholder="Ex: Kira, Hermès..." style="width: 100%; padding: 4px;" />
        </div>
        <div>
          <label style="display: block; font-weight: bold; margin-bottom: 4px;">Personnalité (optionnel)</label>
          <textarea name="muse-personality" rows="5" placeholder="Ex: Sarcastique, formelle, vocabulaire technique." style="width: 100%; padding: 4px; resize: vertical;">${escapeHtml(current.personality)}</textarea>
        </div>
      </form>
    `;

    const self = this;
    new foundry.applications.api.DialogV2({
      window: { title: `Muse de ${pj.name}` },
      position: { width: 500 },
      content,
      buttons: [
        {
          action: "save", label: "Enregistrer", icon: "fas fa-save", default: true,
          callback: async (event, button, dialog) => {
            const root = dialog.element;
            const name = (root.querySelector('input[name="muse-name"]')?.value || "").trim();
            const personality = (root.querySelector('textarea[name="muse-personality"]')?.value || "").trim();
            const all = readMuseAssignments();
            if (name || personality) all[pjId] = { name, personality };
            else delete all[pjId];
            await game.settings.set(MODULE_ID, "museAssignments", JSON.stringify(all));
            ui.notifications.info(name ? `Muse "${name}" enregistrée` : `Muse retirée`);
            self.render(false);
          }
        },
        { action: "cancel", label: "Annuler", icon: "fas fa-times" }
      ]
    }).render(true);
  }

  async _onClearMuse(event, target) {
    const pjId = target.dataset.pjId;
    const pj = game.actors.get(pjId);
    if (!pj) return;
    const all = readMuseAssignments();
    delete all[pjId];
    await game.settings.set(MODULE_ID, "museAssignments", JSON.stringify(all));
    this.render(false);
  }

  async _onTestBackend(event, target) {
    const backendUrl = game.settings.get(MODULE_ID, "backendUrl");
    try {
      const r = await fetch(`${backendUrl}/health`);
      const data = await r.json();
      if (data.status === "ok") {
        ui.notifications.info(`✓ Backend OK (${data.model})`);
      } else {
        ui.notifications.error(`✗ ${data.error}`);
      }
    } catch (e) {
      ui.notifications.error(`✗ ${e.message}`);
    }
  }

  async _onToggleEnabled(event, target) {
    const current = game.settings.get(MODULE_ID, "agentEnabled");
    await game.settings.set(MODULE_ID, "agentEnabled", !current);
    this.render(false);
  }
}

globalThis.MJAssistant = {
  MODULE_ID,
  openPanel: openMJAssistantPanel,
  Panel: MJAssistantPanel,
  readSelectedJournals,
  readPjSheet,
  readMuseAssignments
};