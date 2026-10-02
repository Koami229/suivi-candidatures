#!/usr/bin/env node
/**
 * Étape 3 — migration du front : le magasin « candidats » (localStorage)
 * est remplacé par l'API (Postgres). UI, règles métier et arborescence
 * DOM inchangées ; seule la source de données et les appels changent.
 *
 * Patches (marqueurs vérifiés avant/après) :
 *  P1  suppression du bloc Geoapify (clé en dur) + MANAGER_KEYS front
 *  P2  suppression de `var candidates`
 *  P3  suppression normalizer/fixup/mkCandidate/sampleData/load/save
 *  P4  suppression pipeline local (gating/statut) → statutInfo depuis c.statut
 *  P5  render() → GET /api/candidats (recherche débouncée côté front)
 *  P6  renderPrevivier() → GET /api/previvier + POST /api/previvier/:id/affecter
 *  P7  import CSV/Excel → POST /api/candidats/import (suppression processRows…)
 *  P8  renderStats() → GET /api/stats
 *  P9  PV de synthèse → GET /api/pv
 *  P10 openModal() → GET /api/candidats/:id (déblocages calculés par l'API)
 *  P11 suppression wireResidenceMap (autocomplete — reviendra via proxy API)
 *  P12 enregistrement modal → PUT /api/candidats/:id (identité + info + étapes)
 *  P13 suppression canStillView (garde API sur GET /:id)
 *  P14 suppression du div residence-hint
 *  P15 placeholder résidence → « Adresse de résidence »
 *  P16 suppression de l'appel loadCandidates() à la connexion
 *  P17 suppression du CDN XLSX (l'import est côté serveur)
 *  P18 suppression des CSS Geoapify
 */
import fs, { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../public/index.html', import.meta.url).pathname;
let html = readFileSync(FILE, 'utf8');

function replaceOnce(content, oldText, newText, label) {
  const i = content.indexOf(oldText);
  if (i === -1) throw new Error(`Marqueur introuvable (${label}) : ${JSON.stringify(oldText.slice(0, 90))}`);
  if (content.indexOf(oldText, i + 1) !== -1) throw new Error(`Marqueur non unique (${label})`);
  return content.slice(0, i) + newText + content.slice(i + oldText.length);
}
function cut(content, startMarker, endMarker, label) {
  const i = content.indexOf(startMarker);
  if (i === -1) throw new Error(`Marqueur de début introuvable (${label}) : ${JSON.stringify(startMarker.slice(0, 90))}`);
  const j = content.indexOf(endMarker, i + startMarker.length);
  if (j === -1) throw new Error(`Marqueur de fin introuvable (${label}) : ${JSON.stringify(endMarker.slice(0, 90))}`);
  return content.slice(0, i) + content.slice(j);
}

// ---------------------------------------------------------------- P1 — Geoapify (clé) + MANAGER_KEYS
html = cut(html, '  var MANAGER_KEYS = ["m1","m2","m3"];\n', '  var STAGES = [', 'P1');
html = replaceOnce(
  html,
  '  var INFO_OPTS = ["Pack Office","Excel avancé","Outil CRM","ERP"];\n  var STAGES = [',
  '  var INFO_OPTS = ["Pack Office","Excel avancé","Outil CRM","ERP"];\n\n' +
    '  // Autocomplétion d\'adresse Geoapify : déplacée côté serveur (proxy API, clé en\n' +
    '  // variable d\'environnement) — sera restaurée à l\'étape suivante.\n\n' +
    '  var STAGES = [',
  'P1b'
);

// ---------------------------------------------------------------- P2 — var candidates
html = replaceOnce(html, '  var candidates = [];\n  var activeId = null;', '  var activeId = null;', 'P2');

// ---------------------------------------------------------------- P3 — normalizer / mk / sample / load / save
html = cut(html, '  function normalizeCandidate(c){', '  // ---------- COMPTES / ACCÈS ----------', 'P3');

// ---------------------------------------------------------------- P4 — pipeline local → statut API
html = cut(html, '  // ---------- GATING & VISIBILITY ----------', '  function escapeHtml(str){', 'P4');
html = replaceOnce(
  html,
  '  function escapeHtml(str){',
  '  // Les statuts et la visibilité sont calculés par l\'API (mêmes règles métier que\n' +
    '  // l\'app d\'origine) ; chaque candidat sérialisé porte déjà son code `statut`.\n' +
    '  var STATUT_LABELS = {\n' +
    '    SELECTED:{label:"SELECTED", cls:"selected"},\n' +
    '    PREVIVER:{label:"PRÉ-VIVIER", cls:"amber"},\n' +
    '    REJET:{label:"REJET", cls:"rejet"},\n' +
    '    EN_ATTENTE:{label:"EN ATTENTE", cls:"pending"}\n' +
    '  };\n' +
    '  function statutInfo(c){ return STATUT_LABELS[c.statut] || STATUT_LABELS.EN_ATTENTE; }\n' +
    '\n' +
    '  function escapeHtml(str){',
  'P4b'
);

// ---------------------------------------------------------------- P5 — render() → API
const NEW_RENDER =
  '  // La liste est servie par l\'API (filtrage par rôle inclus : seuil SHL, périmètre\n' +
  '  // recruteur / manager) ; la recherche se fait côté front sur la dernière liste\n' +
  '  // reçue, débouncée — comportement identique à l\'app d\'origine.\n' +
  '  var searchDebounce = null;\n' +
  '  var listData = null;\n' +
  '\n' +
  '  async function render(){\n' +
  '    var body = document.getElementById("table-body");\n' +
  '    body.innerHTML = "";\n' +
  '    try{\n' +
  '      var res = await apiFetch("/api/candidats", { method: "GET" });\n' +
  '      if(!res.ok) throw new Error("http-" + res.status);\n' +
  '      listData = (await res.json()).candidates;\n' +
  '    }catch(e){\n' +
  '      listData = null;\n' +
  '      document.getElementById("empty-state").style.display = "block";\n' +
  '      document.getElementById("empty-sub").textContent = "Impossible de charger la liste des candidats (API indisponible).";\n' +
  '      document.getElementById("count-label").textContent = "0 candidat";\n' +
  '      return;\n' +
  '    }\n' +
  '    renderListFromCache();\n' +
  '  }\n' +
  '  function renderListFromCache(){\n' +
  '    var q = document.getElementById("search").value.trim().toLowerCase();\n' +
  '    var body = document.getElementById("table-body");\n' +
  '    body.innerHTML = "";\n' +
  '    var scoped = listData || [];\n' +
  '    var filtered = scoped.filter(function(c){\n' +
  '      if(!q) return true;\n' +
  '      var hay = (c.nom + " " + c.prenom + " " + c.email).toLowerCase();\n' +
  '      return hay.indexOf(q) !== -1;\n' +
  '    });\n' +
  '    document.getElementById("empty-state").style.display = scoped.length === 0 ? "block" : "none";\n' +
  '    if(currentRole === "recruteur"){\n' +
  '      document.getElementById("empty-sub").textContent = "Aucun nouveau candidat à recevoir en entretien RH pour le moment.";\n' +
  '    } else if(currentRole === "manager"){\n' +
  '      document.getElementById("empty-sub").textContent = "Aucun candidat ne vous a été affecté par le recruteur pour le moment.";\n' +
  '    } else {\n' +
  '      document.getElementById("empty-sub").textContent = "Importez un fichier CSV pour remplir la liste.";\n' +
  '    }\n' +
  '    document.getElementById("count-label").textContent =\n' +
  '      filtered.length + " candidat" + (filtered.length !== 1 ? "s" : "") +\n' +
  '      (q && filtered.length !== scoped.length ? " (sur " + scoped.length + ")" : "");\n' +
  '    filtered.forEach(function(c){\n' +
  '      var tr = document.createElement("tr");\n' +
  '      var st = statutInfo(c);\n' +
  '      tr.innerHTML =\n' +
  '        \'<td><div class="name-cell">\' + escapeHtml(c.nom) + " " + escapeHtml(c.prenom) + \'</div></td>\' +\n' +
  '        \'<td>\' + escapeHtml(c.sexe || "—") + \'</td>\' +\n' +
  '        \'<td>\' + escapeHtml(c.contact) + \'</td>\' +\n' +
  '        \'<td>\' + escapeHtml(c.email) + \'</td>\' +\n' +
  '        \'<td class="score">\' + c.moyenne.toFixed(1) + \'</td>\' +\n' +
  '        \'<td>\' + escapeHtml(c.niveauEtude || "—") + \'</td>\' +\n' +
  '        \'<td><span class="status-badge status-\' + st.cls + \'>\' + st.label + \'</span></td>\' +\n' +
  '        \'<td><button class="btn-view" data-id="\' + c.id + \'>Voir</button></td>\';\n' +
  '      body.appendChild(tr);\n' +
  '    });\n' +
  '    body.querySelectorAll(".btn-view").forEach(function(btn){\n' +
  '      btn.addEventListener("click", function(){ openModal(btn.getAttribute("data-id")); });\n' +
  '    });\n' +
  '  }\n' +
  '  document.getElementById("search").addEventListener("input", function(){\n' +
  '    if(searchDebounce) clearTimeout(searchDebounce);\n' +
  '    searchDebounce = setTimeout(renderListFromCache, 200);\n' +
  '  });\n' +
  '\n';
html = cut(html, '  function render(){', '  // ---------- PRÉ-VIVIER ----------', 'P5');
html = replaceOnce(html, '  // ---------- PRÉ-VIVIER ----------', NEW_RENDER + '  // ---------- PRÉ-VIVIER ----------', 'P5b');

// ---------------------------------------------------------------- P6 — pré-vivier → API
const NEW_PREVIVIER =
  '  async function renderPrevivier(){\n' +
  '    var body = document.getElementById("previvier-body");\n' +
  '    body.innerHTML = "";\n' +
  '    var items;\n' +
  '    try{\n' +
  '      var res = await apiFetch("/api/previvier", { method: "GET" });\n' +
  '      if(!res.ok) throw new Error("http-" + res.status);\n' +
  '      items = (await res.json()).items;\n' +
  '    }catch(e){\n' +
  '      body.innerHTML = \'<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--ink-soft);">Impossible de charger le pré-vivier (API indisponible).</td></tr>\';\n' +
  '      return;\n' +
  '    }\n' +
  '    document.getElementById("previvier-count").textContent = items.length + " candidat" + (items.length !== 1 ? "s" : "") + " en attente d\'affectation";\n' +
  '    if(items.length === 0){\n' +
  '      body.innerHTML = \'<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--ink-soft);">Aucun candidat en pré-vivier pour le moment. Les candidats validés par l\\\'entretien RH apparaîtront ici.</td></tr>\';\n' +
  '      return;\n' +
  '    }\n' +
  '    items.forEach(function(it){\n' +
  '      var c = it.candidat;\n' +
  '      var roundIndex = it.roundIndex;\n' +
  '      var stage = STAGES.find(function(s){ return s.key === it.round; }) || STAGES[0];\n' +
  '      var dejaTraites = it.projetsTraites;\n' +
  '      var assigned = c.projet || "";\n' +
  '      var tr = document.createElement("tr");\n' +
  '      tr.innerHTML =\n' +
  '        \'<td><div class="name-cell">\' + escapeHtml(c.nom) + " " + escapeHtml(c.prenom) + \'</div></td>\' +\n' +
  '        \'<td>\' + escapeHtml(stage.label) + \' <span style="color:var(--ink-soft);font-size:11.5px;">(tour \' + roundIndex + \'/3)</span></td>\' +\n' +
  '        \'<td>\' +\n' +
  '          \'<select class="previvier-select" data-id="\' + c.id + \'" style="padding:7px 9px;border:1px solid var(--line);border-radius:2px;background:var(--paper);font-size:13px;color:var(--ink);min-width:170px;">\' +\n' +
  '            \'<option value="">— Choisir un projet —</option>\' +\n' +
  '            PROJET_OPTS.map(function(p){\n' +
  '              var used = dejaTraites.indexOf(p) !== -1;\n' +
  '              return \'<option value="\' + escapeHtml(p) + \'"\' + (assigned === p ? " selected" : "") + (used ? " disabled" : "") + \'>\' + escapeHtml(p) + (used ? " (déjà reçu en entretien)" : "") + \'</option>\';\n' +
  '            }).join("") +\n' +
  '          \'</select>\' +\n' +
  '        \'</td>\' +\n' +
  '        \'<td style="white-space:nowrap;">\' +\n' +
  '          \'<button class="btn-view previvier-assign" data-id="\' + c.id + \'" style="margin-right:6px;">\' + (assigned ? "Réaffecter" : "Affecter") + \'</button>\' +\n' +
  '          \'<button class="btn-view previvier-view" data-id="\' + c.id + \'>Voir</button>\' +\n' +
  '        \'</td>\';\n' +
  '      body.appendChild(tr);\n' +
  '    });\n' +
  '    body.querySelectorAll(".previvier-assign").forEach(function(btn){\n' +
  '      btn.addEventListener("click", async function(){\n' +
  '        var id = btn.getAttribute("data-id");\n' +
  '        var sel = body.querySelector(\'.previvier-select[data-id="\' + id + \']\');\n' +
  '        var projet = sel.value;\n' +
  '        if(!projet){ alert("Merci de choisir un projet avant d\'affecter le candidat."); return; }\n' +
  '        try{\n' +
  '          var res = await apiFetch("/api/previvier/" + id + "/affecter", {\n' +
  '            method: "POST",\n' +
  '            headers: { "Content-Type": "application/json" },\n' +
  '            body: JSON.stringify({ projet: projet })\n' +
  '          });\n' +
  '          if(!res.ok){\n' +
  '            var d = await res.json().catch(function(){ return {}; });\n' +
  '            throw new Error(d.message || "Affectation impossible.");\n' +
  '          }\n' +
  '        }catch(err){\n' +
  '          alert(err.message || "Affectation impossible.");\n' +
  '          return;\n' +
  '        }\n' +
  '        renderPrevivier();\n' +
  '      });\n' +
  '    });\n' +
  '    body.querySelectorAll(".previvier-view").forEach(function(btn){\n' +
  '      btn.addEventListener("click", function(){ openModal(btn.getAttribute("data-id")); });\n' +
  '    });\n' +
  '  }\n' +
  '\n';
html = cut(html, '  function renderPrevivier(){', '  // ---------- IMPORT CSV / EXCEL ----------', 'P6');
html = replaceOnce(html, '  // ---------- IMPORT CSV / EXCEL ----------', NEW_PREVIVIER + '  // ---------- IMPORT CSV / EXCEL ----------', 'P6b');

// ---------------------------------------------------------------- P7 — import → API
const NEW_IMPORT =
  '  // L\'import est traité CÔTE SERVEUR (Excel/CSV, détection des colonnes, notes SHL,\n' +
  '  // dédoublonnage par email) — logique identique à l\'app d\'origine.\n' +
  '  document.getElementById("csv-input").addEventListener("change", function(e){\n' +
  '    var file = e.target.files[0];\n' +
  '    if(!file) return;\n' +
  '    var form = new FormData();\n' +
  '    form.append("file", file);\n' +
  '    var headers = {};\n' +
  '    if(session && session.access) headers["Authorization"] = "Bearer " + session.access;\n' +
  '    fetch("/api/candidats/import", { method: "POST", headers: headers, body: form })\n' +
  '      .then(function(res){\n' +
  '        return res.json().then(function(d){ return { ok: res.ok, d: d }; });\n' +
  '      })\n' +
  '      .then(function(out){\n' +
  '        if(!out.ok) throw new Error(out.d.message || "Import impossible.");\n' +
  '        alert(\n' +
  '          out.d.added + " candidat(s) importé(s), dont " + out.d.visibles + " avec une moyenne SHL ≥ " + SEUIL + " affiché(s) dans la liste.\\n" +\n' +
  '          out.d.doublons + " doublon(s) détecté(s) (email déjà présent) et ignoré(s)."\n' +
  '        );\n' +
  '        render();\n' +
  '      })\n' +
  '      .catch(function(err){\n' +
  '        alert(err.message || "Import impossible : vérifiez le format du fichier (Excel/CSV).");\n' +
  '      });\n' +
  '    e.target.value = "";\n' +
  '  });\n' +
  '\n';
html = cut(html, '  document.getElementById("csv-input").addEventListener("change", function(e){', '  // ---------- MODAL ----------', 'P7');
html = replaceOnce(html, '  // ---------- MODAL ----------', NEW_IMPORT + '  // ---------- MODAL ----------', 'P7b');

// ---------------------------------------------------------------- P8 — stats → API
const NEW_STATS =
  '  // Les métriques sont calculées par l\'API (mêmes filtres, mêmes règles) ;\n' +
  '  // la répartition par ville n\'est retournée que si "Géolocalisation" = Oui.\n' +
  '  async function renderStats(){\n' +
  '    var from = document.getElementById("f-from").value;\n' +
  '    var to = document.getElementById("f-to").value;\n' +
  '    var sexe = document.getElementById("f-sexe").value;\n' +
  '    var niveau = document.getElementById("f-niveau").value;\n' +
  '    var projet = document.getElementById("f-projet").value;\n' +
  '    var geoloc = document.getElementById("f-geoloc").value;\n' +
  '    var statut = document.getElementById("f-statut").value;\n' +
  '    var params = new URLSearchParams();\n' +
  '    if(from) params.set("from", from);\n' +
  '    if(to) params.set("to", to);\n' +
  '    if(sexe) params.set("sexe", sexe);\n' +
  '    if(niveau) params.set("niveau", niveau);\n' +
  '    if(projet) params.set("projet", projet);\n' +
  '    if(geoloc) params.set("geoloc", geoloc);\n' +
  '    if(statut) params.set("statut", statut);\n' +
  '    var s;\n' +
  '    try{\n' +
  '      var res = await apiFetch("/api/stats?" + params.toString(), { method: "GET" });\n' +
  '      if(!res.ok) throw new Error("http-" + res.status);\n' +
  '      s = await res.json();\n' +
  '    }catch(e){\n' +
  '      document.getElementById("stat-grid").innerHTML = \'<div class="stat-card"><div class="v">—</div><div class="l">API indisponible</div></div>\';\n' +
  '      return;\n' +
  '    }\n' +
  '    var grid = document.getElementById("stat-grid");\n' +
  '    grid.innerHTML = [\n' +
  '      ["Candidats (filtre)", s.total],\n' +
  '      ["Entretiens RH / période", s.rhEntretiens],\n' +
  '      ["Entretiens Manager / période", s.mgrEntretiens],\n' +
  '      ["Hommes", s.hommes],\n' +
  '      ["Femmes", s.femmes],\n' +
  '      ["Moyenne SHL du groupe", s.moyenne.toFixed(1)]\n' +
  '    ].map(function(x){ return \'<div class="stat-card"><div class="v">\' + x[1] + \'</div><div class="l">\' + x[0] + \'</div></div>\'; }).join("");\n' +
  '\n' +
  '    document.getElementById("tbl-niveau").innerHTML = \'<h4>Par niveau d\\\'étude</h4>\' +\n' +
  '      NIVEAU_OPTS.map(function(n){ return \'<div class="row"><span>\' + n + \'</span><span class="n">\' + (s.parNiveau[n] || 0) + \'</span></div>\'; }).join("");\n' +
  '\n' +
  '    document.getElementById("tbl-statut").innerHTML = \'<h4>Par statut</h4>\' +\n' +
  '      Object.keys(s.parStatut).map(function(k){ return \'<div class="row"><span>\' + STATUT_LABELS[k].label + \'</span><span class="n">\' + s.parStatut[k] + \'</span></div>\'; }).join("");\n' +
  '\n' +
  '    // Répartition géographique : n\'apparaît que si "Géolocalisation" = Oui.\n' +
  '    // Ne porte que sur les candidats effectivement reçus en entretien RH (décision RH déjà renseignée),\n' +
  '    // et affiche le pourcentage (et le nombre) par ville de résidence, parmi ce sous-ensemble.\n' +
  '    var tblDept = document.getElementById("tbl-departement");\n' +
  '    if(geoloc === "oui"){\n' +
  '      var villeRows = s.parVille || [];\n' +
  '      var totalRecusRh = s.totalRecusRh || 0;\n' +
  '      tblDept.style.display = "";\n' +
  '      tblDept.innerHTML = \'<h4>Répartition géographique (par ville) — candidats reçus en entretien RH</h4>\' +\n' +
  '        (villeRows.length\n' +
  '          ? villeRows.map(function(row){\n' +
  '              var pct = totalRecusRh ? Math.round((row[1] / totalRecusRh) * 100) : 0;\n' +
  '              return \'<div class="row"><span>\'+escapeHtml(row[0])+\'</span><span class="n">\'+pct+\'% (\'+row[1]+\'</span></div>\';\n' +
  '            }).join("")\n' +
  '          : \'<div class="row"><span>Aucun candidat reçu en entretien RH</span></div>\');\n' +
  '    } else {\n' +
  '      tblDept.style.display = "none";\n' +
  '      tblDept.innerHTML = "";\n' +
  '    }\n' +
  '\n' +
  '    document.getElementById("tbl-rh").innerHTML = \'<h4>Entretiens RH sur la période (décision)</h4>\' +\n' +
  '      \'<div class="row"><span>OK</span><span class="n">\'+s.rhDecisions.ok+\'</span></div>\' +\n' +
  '      \'<div class="row"><span>KO</span><span class="n">\'+s.rhDecisions.ko+\'</span></div>\' +\n' +
  '      \'<div class="row"><span>MB</span><span class="n">\'+s.rhDecisions.mb+\'</span></div>\';\n' +
  '\n' +
  '    document.getElementById("tbl-manager").innerHTML = \'<h4>Entretiens Manager sur la période (décision)</h4>\' +\n' +
  '      \'<div class="row"><span>OK</span><span class="n">\'+s.mgrDecisions.ok+\'</span></div>\' +\n' +
  '      \'<div class="row"><span>KO</span><span class="n">\'+s.mgrDecisions.ko+\'</span></div>\' +\n' +
  '      \'<div class="row"><span>MB</span><span class="n">\'+s.mgrDecisions.mb+\'</span></div>\';\n' +
  '  }\n' +
  '\n';
html = cut(html, '  function inPeriod(dateStr, from, to){', '  // ---------- PV DE SYNTHÈSE (MANAGER) ----------', 'P8');
html = replaceOnce(html, '  // ---------- PV DE SYNTHÈSE (MANAGER) ----------', NEW_STATS + '  // ---------- PV DE SYNTHÈSE (MANAGER) ----------', 'P8b');

// ---------------------------------------------------------------- P9 — PV → API
const NEW_PV =
  '  // Le PV est servi par l\'API : entretiens finalisés (OK, KO ou MB) menés par CE\n' +
  '  // manager (nom de session) sur SON projet, quel que soit le tour (m1, m2, m3),\n' +
  '  // triés par date puis par candidat, avec les compteurs OK / KO / MB.\n' +
  '  async function renderPV(){\n' +
  '    var pv;\n' +
  '    try{\n' +
  '      var res = await apiFetch("/api/pv", { method: "GET" });\n' +
  '      if(!res.ok) throw new Error("http-" + res.status);\n' +
  '      pv = await res.json();\n' +
  '    }catch(e){\n' +
  '      document.getElementById("pv-print-area").innerHTML = \'<div class="pv-empty">Impossible de charger le PV de synthèse (API indisponible).</div>\';\n' +
  '      return;\n' +
  '    }\n' +
  '    var decLabels = {ok:"OK", ko:"KO", mb:"MB"};\n' +
  '    var decClasses = {ok:"selected", ko:"rejet", mb:"amber"};\n' +
  '    var total = pv.total;\n' +
  '    var rows = pv.rows;\n' +
  '\n' +
  '    var html = \'<div class="pv-meta summary-list">\' +\n' +
  '      \'<div><span>Date d\\\'édition</span>\' + escapeHtml(pv.dateEdition) + \'</div>\' +\n' +
  '      \'<div><span>Manager</span>\' + escapeHtml(pv.manager || "—") + \'</div>\' +\n' +
  '      \'<div><span>Projet</span>\' + escapeHtml(pv.projet || "—") + \'</div>\' +\n' +
  '      \'<div><span>Candidats reçus</span>\' + total + \'</div>\' +\n' +
  '    \'</div>\';\n' +
  '\n' +
  '    html += \'<div class="stat-grid">\' +\n' +
  '      [["Candidats reçus", total], ["OK", pv.ok], ["KO", pv.ko], ["MB", pv.mb]]\n' +
  '        .map(function(x){ return \'<div class="stat-card"><div class="v">\' + x[1] + \'</div><div class="l">\' + x[0] + \'</div></div>\'; }).join("") +\n' +
  '    \'</div>\';\n' +
  '\n' +
  '    if(total === 0){\n' +
  '      html += \'<div class="pv-empty">Aucun entretien finalisé (OK, KO ou MB) pour l\\\'instant sur ce projet.</div>\';\n' +
  '    } else {\n' +
  '      html += \'<div class="table-wrap"><table><thead><tr>\' +\n' +
  '          \'<th>Candidat</th><th>Étape</th><th>Date</th><th>Décision</th><th>Commentaire</th>\' +\n' +
  '        \'</tr></thead><tbody>\' +\n' +
  '        rows.map(function(r){\n' +
  '          return \'<tr>\' +\n' +
  '            \'<td>\' + escapeHtml(r.candidat) + \'</td>\' +\n' +
  '            \'<td>\' + escapeHtml(r.etapeLabel) + \'</td>\' +\n' +
  '            \'<td>\' + escapeHtml(r.date || "—") + \'</td>\' +\n' +
  '            \'<td><span class="status-badge status-\' + (decClasses[r.decision] || "pending") + \'>\' + (decLabels[r.decision] || r.decision) + \'</span></td>\' +\n' +
  '            \'<td>\' + escapeHtml(r.commentaire || "—") + \'</td>\' +\n' +
  '          \'</tr>\';\n' +
  '        }).join("") +\n' +
  '      \'</tbody></table></div>\';\n' +
  '    }\n' +
  '\n' +
  '    document.getElementById("pv-print-area").innerHTML = html;\n' +
  '  }\n' +
  '\n';
html = cut(html, '  function collectManagerInterviews(managerName, projet){', '  document.getElementById("btn-generate-pv").addEventListener("click", function(){', 'P9');
html = replaceOnce(html, '  document.getElementById("btn-generate-pv").addEventListener("click", function(){', NEW_PV + '  document.getElementById("btn-generate-pv").addEventListener("click", function(){', 'P9b');

// ---------------------------------------------------------------- P10 — openModal → API
const NEW_OPENMODAL =
  '  // La fiche est servie par l\'API (périmètre par rôle vérifié) ; les étapes\n' +
  '  // débloquées et le tour du manager sont calculés côté serveur.\n' +
  '  async function openModal(id){\n' +
  '    var data;\n' +
  '    try{\n' +
  '      var res = await apiFetch("/api/candidats/" + id, { method: "GET" });\n' +
  '      if(!res.ok) return;\n' +
  '      data = await res.json();\n' +
  '    }catch(e){ return; }\n' +
  '    var c = data.candidat;\n' +
  '    activeId = id;\n' +
  '    fillHeader(c);\n' +
  '\n' +
  '    var body = document.getElementById("modal-body");\n' +
  '    body.innerHTML = "";\n' +
  '\n' +
  '    if(currentRole === "rh"){\n' +
  '      // RH dispose des pleins droits de modification, à tous les niveaux du dossier\n' +
  '      // (identité, informations candidat, et l\'ensemble des entretiens réalisés ou à venir).\n' +
  '      body.appendChild(renderIdentityBlock(c, true));\n' +
  '      body.appendChild(renderInfoSectionFull(c, true));\n' +
  '      wireDomaineRequirement();\n' +
  '      wireHeaderLiveSync();\n' +
  '      var hist = renderHistoryBlock(c);\n' +
  '      if(hist) body.appendChild(hist);\n' +
  '      STAGES.forEach(function(stage){\n' +
  '        body.appendChild(renderStageSection(c, stage, data.stages[stage.key].reachable, true));\n' +
  '      });\n' +
  '    } else if(currentRole === "recruteur"){\n' +
  '      // Le recruteur peut modifier l\'identité et toutes les informations du candidat,\n' +
  '      // mais ne voit que la rubrique concernant son propre entretien (l\'entretien RH) —\n' +
  '      // pas les entretiens managers, qui ne le concernent pas.\n' +
  '      body.appendChild(renderIdentityBlock(c, true));\n' +
  '      body.appendChild(renderInfoSectionFull(c, true));\n' +
  '      wireDomaineRequirement();\n' +
  '      wireHeaderLiveSync();\n' +
  '      var rhStage = STAGES.find(function(s){ return s.key === "rh"; });\n' +
  '      body.appendChild(renderStageSection(c, rhStage, true, false));\n' +
  '    } else if(currentRole === "manager"){\n' +
  '      body.appendChild(renderInfoSummaryReadOnly(c));\n' +
  '      var myStage = data.myRound ? STAGES.find(function(s){ return s.key === data.myRound; }) : null;\n' +
  '      if(myStage) body.appendChild(renderStageSection(c, myStage, true, false));\n' +
  '    }\n' +
  '\n' +
  '    document.getElementById("save-note").classList.remove("show");\n' +
  '    document.getElementById("overlay").style.display = "flex";\n' +
  '  }\n' +
  '  ';
html = cut(html, '  function openModal(id){', '  function closeModal(){', 'P10');
html = replaceOnce(html, '  function closeModal(){', NEW_OPENMODAL + 'function closeModal(){', 'P10b');

// ---------------------------------------------------------------- P11 — wireResidenceMap
html = cut(html, '  // Autocomplétion d\'adresse Geoapify, restreinte au Bénin, pour faciliter', '  // Le domaine d\'étude n\'est pas obligatoire pour les niveaux BAC et BEPC.', 'P11');

// ---------------------------------------------------------------- P12 — enregistrement modal → PUT
const NEW_SAVE =
  '  // Validation des champs obligatoires (identique à l\'app), puis envoi à l\'API :\n' +
  '  // identité + informations candidat (RH / recruteur) et entretiens tranchés.\n' +
  '  // Les règles de verrouillage (entretien saisi = définitif, déblocage séquentiel,\n' +
  '  // périmètre manager) sont appliquées CÔTE SERVEUR.\n' +
  '  document.getElementById("modal-save").addEventListener("click", async function(){\n' +
  '    var missingLabels = [];\n' +
  '    var payload = {};\n' +
  '\n' +
  '    if(currentRole === "rh" || currentRole === "recruteur"){\n' +
  '      var idNom = document.getElementById("identity-nom");\n' +
  '      var idPrenom = document.getElementById("identity-prenom");\n' +
  '      var idEmail = document.getElementById("identity-email");\n' +
  '      var idContact = document.getElementById("identity-contact");\n' +
  '      if(!idNom || idNom.value.trim() === "") missingLabels.push("nom");\n' +
  '      payload.identity = {\n' +
  '        nom: idNom ? idNom.value.trim() : "",\n' +
  '        prenom: idPrenom ? idPrenom.value.trim() : "",\n' +
  '        email: idEmail ? idEmail.value.trim() : "",\n' +
  '        contact: idContact ? idContact.value.trim() : ""\n' +
  '      };\n' +
  '    }\n' +
  '\n' +
  '    if(currentRole === "rh" || currentRole === "recruteur"){\n' +
  '      var age = document.getElementById("info-age");\n' +
  '      var sexe = document.getElementById("info-sexe");\n' +
  '      var residence = document.getElementById("info-residence");\n' +
  '      var niveau = document.getElementById("info-niveau");\n' +
  '      var domaine = document.getElementById("info-domaine");\n' +
  '\n' +
  '      var ageStr = age.value.trim();\n' +
  '      var ageVal = parseInt(ageStr, 10);\n' +
  '      var ageOk = ageStr !== "" && !isNaN(ageVal) && ageVal >= 18;\n' +
  '      age.classList.toggle("input-error", !ageOk);\n' +
  '      if(!ageOk) missingLabels.push(ageStr === "" ? "âge" : "âge (18 ans minimum)");\n' +
  '\n' +
  '      [[sexe,"sexe"],[residence,"résidence"],[niveau,"niveau d\'étude"]].forEach(function(pair){\n' +
  '        var ok = pair[0].value.trim() !== "";\n' +
  '        pair[0].classList.toggle("input-error", !ok);\n' +
  '        if(!ok) missingLabels.push(pair[1]);\n' +
  '      });\n' +
  '\n' +
  '      var domaineRequired = niveau.value !== "BAC" && niveau.value !== "BEPC";\n' +
  '      var domaineOk = !domaineRequired || domaine.value.trim() !== "";\n' +
  '      domaine.classList.toggle("input-error", !domaineOk);\n' +
  '      if(!domaineOk) missingLabels.push("domaine d\'étude");\n' +
  '\n' +
  '      if(missingLabels.length === 0){\n' +
  '        var deptField = document.getElementById("info-residence-departement");\n' +
  '        var villeField = document.getElementById("info-residence-ville");\n' +
  '        var latField = document.getElementById("info-residence-lat");\n' +
  '        var lngField = document.getElementById("info-residence-lng");\n' +
  '        var experience = document.getElementById("info-experience");\n' +
  '        payload.info = {\n' +
  '          age: age.value,\n' +
  '          sexe: sexe.value,\n' +
  '          residence: residence.value,\n' +
  '          niveau: niveau.value,\n' +
  '          domaine: domaine.value,\n' +
  '          departement: deptField ? deptField.value : "",\n' +
  '          ville: villeField ? villeField.value : "",\n' +
  '          residenceLat: latField ? latField.value : "",\n' +
  '          residenceLng: lngField ? lngField.value : "",\n' +
  '          experience: experience ? experience.value : "",\n' +
  '          langues: Array.prototype.slice.call(document.querySelectorAll(\'[data-info-check="langues"]:checked\')).map(function(el){ return el.value; }),\n' +
  '          informatique: Array.prototype.slice.call(document.querySelectorAll(\'[data-info-check="informatique"]:checked\')).map(function(el){ return el.value; })\n' +
  '        };\n' +
  '      }\n' +
  '    }\n' +
  '\n' +
  '    var FIELD_LABELS = {recruteur:"recruteur", projet:"projet", date:"date de l\'entretien", commentaire:"commentaire", decision:"décision (OK, KO ou MB)"};\n' +
  '    document.querySelectorAll(\'#modal-body [data-required="1"]\').forEach(function(el){\n' +
  '      if(el.disabled) return;\n' +
  '      var field = el.getAttribute("data-field");\n' +
  '      // La décision doit être explicitement tranchée : "À réaliser" ne peut pas être enregistré.\n' +
  '      var ok = field === "decision" ? el.value !== "a_faire" : el.value.trim() !== "";\n' +
  '      el.classList.toggle("input-error", !ok);\n' +
  '      if(!ok){\n' +
  '        var stageLbl = STAGES.find(function(s){ return s.key === el.getAttribute("data-stage"); });\n' +
  '        var fieldLbl = FIELD_LABELS[field] || field;\n' +
  '        missingLabels.push((stageLbl ? stageLbl.label + " — " : "") + fieldLbl);\n' +
  '      }\n' +
  '    });\n' +
  '\n' +
  '    if(missingLabels.length){\n' +
  '      alert("Merci de renseigner les champs obligatoires manquants :\\n— " + missingLabels.join("\\n— "));\n' +
  '      return;\n' +
  '    }\n' +
  '\n' +
  '    payload.stages = {};\n' +
  '    document.querySelectorAll("#modal-body [data-stage]").forEach(function(el){\n' +
  '      if(el.disabled) return;\n' +
  '      var stage = el.getAttribute("data-stage");\n' +
  '      if(!payload.stages[stage]) payload.stages[stage] = { note: "", date: "", commentaire: "", decision: "a_faire" };\n' +
  '      payload.stages[stage][el.getAttribute("data-field")] = el.value;\n' +
  '    });\n' +
  '    // Seuls les entretiens réellement tranchés sont envoyés ; "À réaliser" reste à faire.\n' +
  '    Object.keys(payload.stages).forEach(function(k){\n' +
  '      if(payload.stages[k].decision === "a_faire") delete payload.stages[k];\n' +
  '    });\n' +
  '\n' +
  '    try{\n' +
  '      var res = await apiFetch("/api/candidats/" + activeId, {\n' +
  '        method: "PUT",\n' +
  '        headers: { "Content-Type": "application/json" },\n' +
  '        body: JSON.stringify(payload)\n' +
  '      });\n' +
  '      if(!res.ok){\n' +
  '        var d = await res.json().catch(function(){ return {}; });\n' +
  '        if(d.missing && d.missing.length){\n' +
  '          throw new Error("Merci de renseigner les champs obligatoires manquants :\\n— " + d.missing.join("\\n— "));\n' +
  '        }\n' +
  '        throw new Error(d.message || "Enregistrement impossible.");\n' +
  '      }\n' +
  '    }catch(err){\n' +
  '      alert(err.message || "Enregistrement impossible.");\n' +
  '      return;\n' +
  '    }\n' +
  '    render();\n' +
  '    if(currentView === "previvier") renderPrevivier();\n' +
  '    closeModal();\n' +
  '  });\n' +
  '\n';
html = cut(html, '  document.getElementById("modal-save").addEventListener("click", function(){', '  // Le recruteur peut ouvrir une fiche depuis "Candidats"', 'P12');
html = replaceOnce(html, '  // Le recruteur peut ouvrir une fiche depuis "Candidats"', NEW_SAVE + '  // Le recruteur peut ouvrir une fiche depuis "Candidats"', 'P12b');

// ---------------------------------------------------------------- P13 — canStillView (garde API)
html = cut(html, '  // Le recruteur peut ouvrir une fiche depuis "Candidats"', '  // ---------- STATISTIQUES ----------', 'P13');

// ---------------------------------------------------------------- P14 — div residence-hint
html = replaceOnce(
  html,
  "            (editable ? '<div class=\"residence-hint\" id=\"residence-hint\"></div>' : '') +\n",
  '',
  'P14'
);

// ---------------------------------------------------------------- P15 — placeholder résidence
html = replaceOnce(html, 'placeholder="Rechercher une adresse au Bénin…"', 'placeholder="Adresse de résidence"', 'P15');

// ---------------------------------------------------------------- P16 — appel loadCandidates()
html = replaceOnce(html, '    loadCandidates();\n    buildTableHead();', '    buildTableHead();', 'P16');

// ---------------------------------------------------------------- P17 — CDN XLSX
html = replaceOnce(html, '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>\n', '', 'P17');

// ---------------------------------------------------------------- P18 — CSS Geoapify
html = cut(html, '  .geoapify-suggestions{display:none;', '  #csv-input{display:none;}', 'P18');
html = replaceOnce(html, '  .residence-hint{font-size:11.5px; color:var(--ink-soft); margin-top:4px;}\n', '', 'P18b');

// ---------------------------------------------------------------- résidus interdits
const FORBIDDEN = [
  ['clé Geoapify en dur', /[a-f0-9]{32}/i],
  ['const GEOAPIFY_API_KEY', /GEOAPIFY_API_KEY/],
  ['geoapifyAutocomplete', /geoapifyAutocomplete/],
  ['extractDepartementFromGeoapifyResult', /extractDepartementFromGeoapifyResult/],
  ['store localStorage candidats', /STORAGE_KEY/],
  ['var candidates', /\bcandidates\s*=/],
  ['saveCandidates', /saveCandidates/],
  ['loadCandidates', /loadCandidates/],
  ['sampleData', /sampleData/],
  ['mkCandidate', /mkCandidate/],
  ['normalizeCandidate', /normalizeCandidate/],
  ['fixupLegacy', /fixupLegacy/],
  ['computeMoyenne (front)', /computeMoyenne/],
  ['processRows (front)', /processRows/],
  ['splitLine (front)', /splitLine/],
  ['splitFullName (front)', /splitFullName/],
  ['visibleForRole (front)', /visibleForRole/],
  ['computeStatutCode (front)', /computeStatutCode/],
  ['isStageUnlocked (front)', /isStageUnlocked/],
  ['currentManagerRound (front)', /currentManagerRound/],
  ['projetsDejaTraites (front)', /projetsDejaTraites/],
  ['estDansPrevivier (front)', /estDansPrevivier/],
  ['estSortiDefinitivement (front)', /estSortiDefinitivement/],
  ['passesThreshold (front)', /passesThreshold/],
  ['canStillView (front)', /canStillView/],
  ['inPeriod (front)', /inPeriod/],
  ['collectManagerInterviews (front)', /collectManagerInterviews/],
  ['MANAGER_KEYS (front)', /MANAGER_KEYS/],
  ['wireResidenceMap', /wireResidenceMap/],
  ['BENIN_DEPARTEMENTS (front)', /BENIN_DEPARTEMENTS/],
  ['CDN XLSX', /cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx/],
  ['residence-hint', /residence-hint/],
];
const found = FORBIDDEN.filter(([, re]) => re.test(html)).map(([label]) => label);
if (found.length) throw new Error('Résidus interdits encore présents : ' + found.join(' | '));

// ---------------------------------------------------------------- vérification syntaxique du script inline
const inlineMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!inlineMatch) throw new Error('bloc <script> inline introuvable');
try {
  new Function(inlineMatch[1]);
} catch (e) {
  throw new Error('erreur de syntaxe dans le script inline : ' + e.message);
}

writeFileSync(FILE, html);
console.log('OK  public/index.html migré (étape 3) — ' + html.split('\n').length + ' lignes');
