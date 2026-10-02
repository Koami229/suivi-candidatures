#!/usr/bin/env node
/**
 * Étape 2 — migration du front vers l'API (uniquement l'authentification).
 *
 * Applique à public/index.html (copie de l'app originale) un jeu de
 * remplacements par marqueurs (chaque marqueur doit être UNIQUE dans le
 * fichier ; sinon le script échoue SANS écrire). Ensuite :
 *  - vérifie qu'aucun résidu de l'ancienne auth locale ne subsiste
 *    (comptes localStorage, mots de passe démo, TOTP côté client…) ;
 *  - valide la syntaxe du <script> inline.
 *
 * Usage : node scripts/migrate-front-step2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'index.html');
let content = fs.readFileSync(FILE, 'utf8');

const patches = [
  // ---------------------------------------------------------------- P1
  {
    name: 'P1 — suppression des comptes par défaut + clés localStorage comptes/session',
    start: "  // Comptes par défaut (utilisés si aucun compte n'a encore été personnalisé par l'admin).",
    end: '  var SESSION_KEY = "recrutement_session_v7";',
    replacement: `  // Migration production : les comptes ne vivent PLUS dans le navigateur (localStorage) :
  // ils sont gérés par l'API (base Postgres) — /api/auth/* et /api/comptes (admin).
  // Aucun identifiant de démonstration n'est présent dans ce fichier.`,
  },
  // ---------------------------------------------------------------- P0
  {
    name: 'P0 — suppression de la fonction loadAccounts (comptes en base)',
    start: '  // ---------- COMPTES / ACCÈS ----------',
    end: `    Object.keys(accounts).forEach(function(u){ if(accounts[u].totpSecret === undefined) accounts[u].totpSecret = null; });
  }`,
    replacement: `  // ---------- COMPTES / ACCÈS ----------
  // Les accès Manager et Recruteur sont gérés par l'API (base Postgres) :
  // /api/comptes (admin RH) et /api/auth/* (connexion, activation, 2FA).`,
  },
  // ---------------------------------------------------------------- P2
  {
    name: 'P2 — TOTP : plus de calcul côté client (vérifié côté serveur)',
    start: '  // ---------- DOUBLE AUTHENTIFICATION (TOTP, RFC 6238) — calculée localement, sans serveur ----------',
    end: '    return "otpauth://totp/" + label + "?secret=" + base32Secret + "&issuer=" + encodeURIComponent(TOTP_ISSUER) + "&digits=6&period=30";\n  }',
    replacement: `  // ---------- DOUBLE AUTHENTIFICATION (TOTP, RFC 6238) — vérifiée CÔTE SERVEUR ----------
  // Le serveur génère la clé, fournit l'URI otpauth:// et vérifie le code saisi.
  // Le front ne fait plus aucun calcul TOTP (aucune dépendance à Web Crypto).
  function formatSecretForDisplay(secret){
    return (secret || "").match(/.{1,4}/g).join(" ");
  }`,
  },
  // ---------------------------------------------------------------- P3
  {
    name: 'P3 — comptes : fonctions basées sur currentUser + modal lien d\'activation (lien fourni par l\'API)',
    start: '  function saveAccounts(){',
    end: `  function currentAccedantFullName(){
    var acc = accounts[currentUser];
    return acc ? accountFullName(acc) : "";
  }`,
    replacement: `  // (Les comptes sont gérés côté serveur — API /api/comptes et /api/auth/*)
  function currentAccedantFullName(){
    if(!currentUser) return "";
    return ((currentUser.prenom || "") + " " + (currentUser.nom || "")).trim();
  }
  function accountLabel(){
    if(!currentUser) return "—";
    if(currentUser.role === "rh") return "RH — administration complète";
    var full = currentAccedantFullName();
    if(currentUser.role === "recruteur") return "Recruteur — " + (full || currentUser.username);
    if(currentUser.role === "manager") return "Manager — " + (full || currentUser.username);
    return currentUser.username;
  }
  function openActivationLinkModal(email, link, prenom){
    document.getElementById("activation-link-email").textContent = email;
    document.getElementById("activation-link-value").value = link;
    var subject = encodeURIComponent("Votre accès — Suivi des candidatures");
    var body = encodeURIComponent(
      "Bonjour" + (prenom ? " " + prenom : "") + ",\\n\\n" +
      "Un accès vous a été créé sur l'application Suivi des candidatures.\\n" +
      "Identifiant : " + email + "\\n\\n" +
      "Cliquez sur ce lien pour définir votre mot de passe :\\n" + link + "\\n\\n" +
      "Cordialement."
    );
    document.getElementById("activation-link-mailto").href = "mailto:" + encodeURIComponent(email) + "?subject=" + subject + "&body=" + body;
    document.getElementById("activation-link-overlay").style.display = "flex";
  }
  document.getElementById("activation-link-close").addEventListener("click", function(){ document.getElementById("activation-link-overlay").style.display = "none"; });
  document.getElementById("activation-link-overlay").addEventListener("click", function(e){ if(e.target === e.currentTarget) document.getElementById("activation-link-overlay").style.display = "none"; });
  document.getElementById("activation-link-copy").addEventListener("click", function(){
    var input = document.getElementById("activation-link-value");
    input.select();
    input.setSelectionRange(0, 99999);
    try{
      if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value);
      else document.execCommand("copy");
    }catch(e){}
  });`,
  },
  // ---------------------------------------------------------------- P4a
  {
    name: 'P4a — session JWT (remplace sessionStorage) + apiFetch avec refresh',
    start: '  function applyAccount(u){',
    end: `  function checkSession(){
    loadAccounts();
    var raw = null;
    try{ raw = sessionStorage.getItem(SESSION_KEY); }catch(e){}
    if(raw){
      try{
        var s = JSON.parse(raw);
        if(accounts[s.user]){ applyAccount(s.user); showApp(); return; }
      }catch(e){}
    }
    showLogin();
  }`,
    replacement: `  // ---------- SESSION (JWT, remplace l'ancienne session navigateur) ----------
  var SESSION_STORE_KEY = "sc_session_v1";
  var session = null;        // {access, refresh}
  var preauthTicket = null;  // ticket de connexion en attente du code 2FA

  function loadSession(){
    try{
      var raw = localStorage.getItem(SESSION_STORE_KEY);
      session = raw ? JSON.parse(raw) : null;
    }catch(e){ session = null; }
    return session;
  }
  function saveSession(s){
    session = s;
    try{ localStorage.setItem(SESSION_STORE_KEY, JSON.stringify(s)); }catch(e){}
  }
  function clearSession(){
    session = null;
    try{ localStorage.removeItem(SESSION_STORE_KEY); }catch(e){}
  }
  function applyUser(user){
    currentUser = user;
    currentRole = user.role;
    var full = currentAccedantFullName();
    currentManagerName = user.role === "manager" ? (full || null) : null;
    currentManagerProjet = user.role === "manager" ? (user.projet || null) : null;
  }
  // Appelle l'API avec le token d'accès ; en cas de 401, tente une fois le
  // renouvellement (refresh token) puis relance l'appel.
  async function apiFetch(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers);
    if(session && session.access) opts.headers["Authorization"] = "Bearer " + session.access;
    var res = await fetch(path, opts);
    if(res.status === 401 && session && session.refresh){
      var r = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh })
      });
      if(r.ok){
        var nt = await r.json();
        saveSession(nt);
        opts.headers["Authorization"] = "Bearer " + session.access;
        res = await fetch(path, opts);
      }
    }
    return res;
  }
  async function checkSession(){
    loadSession();
    if(session){
      try{
        var res = await apiFetch("/api/auth/me", { method: "GET" });
        if(res.ok){
          applyUser(await res.json());
          showApp();
          return;
        }
      }catch(e){}
    }
    clearSession();
    showLogin();
  }`,
  },
  // ---------------------------------------------------------------- P4b
  {
    name: 'P4b — accountLabel() sans argument',
    start: '    var label = accountLabel(currentUser);',
    end: '    var label = accountLabel(currentUser);',
    replacement: '    var label = accountLabel();',
  },
  // ---------------------------------------------------------------- P4c
  {
    name: 'P4c — login + 2FA via l\'API',
    start: '  document.getElementById("login-form").addEventListener("submit", function(e){',
    end: `      twofaPendingUser = null; twofaPendingSecret = null;
      document.getElementById("twofa-screen").style.display = "none";
      finalizeLogin(u);
    });
  });`,
    replacement: `  document.getElementById("login-form").addEventListener("submit", async function(e){
    e.preventDefault();
    var u = document.getElementById("user").value.trim().toLowerCase();
    var p = document.getElementById("pass").value;
    var errEl = document.getElementById("login-error");
    if(!isConcentrixEmail(u)){
      errEl.textContent = "L'identifiant doit être une adresse email se terminant par @concentrix.com.";
      errEl.style.display = "block";
      return;
    }
    errEl.style.display = "none";
    try{
      var res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: u, password: p })
      });
      var data = await res.json().catch(function(){ return {}; });
      if(!res.ok){
        errEl.textContent = data.message || "Identifiant ou mot de passe incorrect.";
        errEl.style.display = "block";
        return;
      }
      // La double authentification est obligatoire et vérifiée côté serveur.
      preauthTicket = data.ticket;
      document.getElementById("login-screen").style.display = "none";
      document.getElementById("twofa-error").style.display = "none";
      document.getElementById("twofa-form").reset();
      if(data.setup){
        // Première connexion : configuration de la 2FA (clé fournie par le serveur).
        document.getElementById("twofa-title").textContent = "Configurer la double authentification";
        document.getElementById("twofa-sub").textContent = "Ce compte n'a pas encore de double authentification active — elle est obligatoire pour continuer.";
        document.getElementById("twofa-secret").value = formatSecretForDisplay(data.setup.secret);
        document.getElementById("twofa-uri").value = data.setup.otpauth_uri;
        document.getElementById("twofa-setup-block").style.display = "block";
        document.getElementById("twofa-submit").textContent = "Activer la double authentification";
      }else{
        document.getElementById("twofa-title").textContent = "Double authentification";
        document.getElementById("twofa-sub").textContent = "Entrez le code à 6 chiffres généré par votre application d'authentification.";
        document.getElementById("twofa-setup-block").style.display = "none";
        document.getElementById("twofa-submit").textContent = "Vérifier";
      }
      document.getElementById("twofa-screen").style.display = "flex";
    }catch(err){
      errEl.textContent = "Erreur de connexion au serveur.";
      errEl.style.display = "block";
    }
  });
  function completeLogin(data){
    saveSession({ access: data.access_token, refresh: data.refresh_token });
    applyUser(data.user);
    preauthTicket = null;
    document.getElementById("twofa-screen").style.display = "none";
    showApp();
  }
  document.getElementById("twofa-cancel").addEventListener("click", function(){
    preauthTicket = null;
    document.getElementById("twofa-screen").style.display = "none";
    document.getElementById("login-form").reset();
    showLogin();
  });
  document.getElementById("twofa-form").addEventListener("submit", async function(e){
    e.preventDefault();
    var code = document.getElementById("twofa-code").value;
    var errEl = document.getElementById("twofa-error");
    if(!preauthTicket){
      errEl.textContent = "Session de connexion expirée — reconnectez-vous.";
      errEl.style.display = "block";
      return;
    }
    try{
      var res = await fetch("/api/auth/twofa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: preauthTicket, code: code })
      });
      var data = await res.json().catch(function(){ return {}; });
      if(!res.ok){
        errEl.textContent = data.message || "Code incorrect ou expiré.";
        errEl.style.display = "block";
        return;
      }
      completeLogin(data);
    }catch(err){
      errEl.textContent = "Erreur de connexion au serveur.";
      errEl.style.display = "block";
    }
  });`,
  },
  // ---------------------------------------------------------------- P4d
  {
    name: 'P4d — déconnexion (révocation du refresh token côté serveur)',
    start: '  document.getElementById("btn-logout").addEventListener("click", function(){',
    end: `    try{ sessionStorage.removeItem(SESSION_KEY); }catch(e){}
    currentRole = null; currentUser = null; currentManagerName = null; currentManagerProjet = null;
    document.getElementById("login-form").reset();
    showLogin();
  });`,
    replacement: `  document.getElementById("btn-logout").addEventListener("click", function(){
    if(session && session.refresh){
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh })
      }).catch(function(){});
    }
    clearSession();
    preauthTicket = null;
    currentRole = null; currentUser = null; currentManagerName = null; currentManagerProjet = null;
    document.getElementById("login-form").reset();
    showLogin();
  });`,
  },
  // ---------------------------------------------------------------- P5
  {
    name: 'P5 — activation de compte via l\'API',
    start: "  // ---------- ACTIVATION DE COMPTE (LIEN REÇU PAR EMAIL) ----------",
    end: `    document.getElementById("login-error").textContent = "Mot de passe défini avec succès — vous pouvez vous connecter.";
    document.getElementById("login-error").style.display = "block";
  });`,
    replacement: `  // ---------- ACTIVATION DE COMPTE (LIEN REÇU PAR EMAIL) ----------
  var activationToken = null;
  async function checkActivationLink(){
    var params = new URLSearchParams(location.search);
    var token = params.get("activation");
    if(!token) return false;
    var ok = false;
    try{
      var res = await fetch("/api/auth/activate?token=" + encodeURIComponent(token), { method: "GET" });
      var data = await res.json().catch(function(){ return {}; });
      if(res.ok && data.valid){
        activationToken = token;
        document.getElementById("activation-sub").textContent = "Bienvenue " + (data.prenom || data.username) + " — choisissez votre mot de passe pour activer votre accès.";
        document.getElementById("login-screen").style.display = "none";
        document.getElementById("app").style.display = "none";
        document.getElementById("activation-screen").style.display = "flex";
        ok = true;
      }
    }catch(e){}
    if(!ok){
      document.getElementById("login-error").textContent = "Ce lien d'activation n'est pas valide ou a expiré.";
      document.getElementById("login-error").style.display = "block";
    }
    return ok;
  }
  document.getElementById("activation-form").addEventListener("submit", async function(e){
    e.preventDefault();
    var p1 = document.getElementById("activation-pass1").value;
    var p2 = document.getElementById("activation-pass2").value;
    var errEl = document.getElementById("activation-error");
    if(!p1 || p1 !== p2){
      errEl.textContent = "Les mots de passe ne correspondent pas.";
      errEl.style.display = "block";
      return;
    }
    var issues = passwordIssues(p1);
    if(issues.length){
      errEl.textContent = "Le mot de passe doit contenir : " + issues.join(", ") + ".";
      errEl.style.display = "block";
      return;
    }
    try{
      var res = await fetch("/api/auth/activation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: activationToken, password: p1 })
      });
      var data = await res.json().catch(function(){ return {}; });
      if(!res.ok){
        errEl.textContent = data.message || "Ce lien n'est plus valide.";
        errEl.style.display = "block";
        return;
      }
      errEl.style.display = "none";
      try{ history.replaceState(null, "", location.origin + location.pathname); }catch(err){}
      document.getElementById("activation-screen").style.display = "none";
      document.getElementById("activation-form").reset();
      showLogin();
      document.getElementById("login-error").textContent = "Mot de passe défini avec succès — vous pouvez vous connecter (et configurer la double authentification).";
      document.getElementById("login-error").style.display = "block";
    }catch(err){
      errEl.textContent = "Erreur de connexion au serveur.";
      errEl.style.display = "block";
    }
  });`,
  },
  // ---------------------------------------------------------------- P6a
  {
    name: 'P6a — statut 2FA depuis l\'API',
    start: '  function refreshTwofaManageStatus(){',
    end: `      statusEl.textContent = "Aucune double authentification n'est configurée sur ce compte pour l'instant.";
    }
  }`,
    replacement: `  function refreshTwofaManageStatus(){
    var statusEl = document.getElementById("twofa-manage-status");
    apiFetch("/api/auth/twofa-status", { method: "GET" }).then(function(r){ return r.json(); })
      .then(function(d){
        statusEl.textContent = d.configured
          ? "La double authentification est actuellement active sur ce compte."
          : "Aucune double authentification n'est configurée sur ce compte pour l'instant.";
      })
      .catch(function(){
        statusEl.textContent = "Statut de la double authentification indisponible.";
      });
  }`,
  },
  // ---------------------------------------------------------------- P6b
  {
    name: 'P6b — régénération de clé 2FA via l\'API',
    start: '  document.getElementById("twofa-manage-regenerate").addEventListener("click", function(){',
    end: `    document.getElementById("twofa-manage-status").textContent = "Ajoutez cette nouvelle clé dans votre application d'authentification, puis confirmez avec le code généré. L'ancienne clé restera active tant que vous n'aurez pas confirmé.";
  });`,
    replacement: `  document.getElementById("twofa-manage-regenerate").addEventListener("click", function(){
    apiFetch("/api/auth/twofa-regenerate", { method: "POST" }).then(function(r){
      return r.json().then(function(d){ return { ok: r.ok, d: d }; });
    }).then(function(out){
      if(!out.ok){ alert(out.d.message || "Génération impossible."); return; }
      manageTwofaPendingSecret = out.d.ticket;
      document.getElementById("twofa-manage-secret").value = formatSecretForDisplay(out.d.secret);
      document.getElementById("twofa-manage-uri").value = out.d.otpauth_uri;
      document.getElementById("twofa-manage-setup").style.display = "block";
      document.getElementById("twofa-manage-confirm").style.display = "inline-flex";
      document.getElementById("twofa-manage-status").textContent = "Ajoutez cette nouvelle clé dans votre application d'authentification, puis confirmez avec le code généré. L'ancienne clé restera active tant que vous n'aurez pas confirmé.";
    }).catch(function(){
      alert("Erreur de connexion au serveur.");
    });
  });`,
  },
  // ---------------------------------------------------------------- P6c
  {
    name: 'P6c — confirmation de la nouvelle clé 2FA via l\'API',
    start: '  document.getElementById("twofa-manage-confirm").addEventListener("click", function(){',
    end: `      alert("Double authentification activée avec succès.");
    });
  });`,
    replacement: `  document.getElementById("twofa-manage-confirm").addEventListener("click", function(){
    var code = document.getElementById("twofa-manage-code").value;
    if(!manageTwofaPendingSecret) return;
    apiFetch("/api/auth/twofa-confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: manageTwofaPendingSecret, code: code })
    }).then(function(r){
      return r.json().then(function(d){ return { ok: r.ok, d: d }; });
    }).then(function(out){
      if(!out.ok){ alert(out.d.message || "Code incorrect ou expiré. Vérifiez l'heure de votre appareil et réessayez."); return; }
      manageTwofaPendingSecret = null;
      closePwdModal();
      alert("Double authentification activée avec succès.");
    }).catch(function(){
      alert("Erreur de connexion au serveur.");
    });
  });`,
  },
  // ---------------------------------------------------------------- P6d
  {
    name: 'P6d — changement de mot de passe via l\'API (plus de vérification locale du mot de passe actuel)',
    start: '  document.getElementById("pwd-modal-save").addEventListener("click", function(){',
    end: `    acc.pass = newEl.value;
    saveAccounts();
    closePwdModal();
  });`,
    replacement: `  document.getElementById("pwd-modal-save").addEventListener("click", async function(){
    var curEl = document.getElementById("pwd-current");
    var newEl = document.getElementById("pwd-new");
    var confEl = document.getElementById("pwd-confirm");
    var missing = [];

    var curFilled = curEl.value !== "";
    curEl.classList.toggle("input-error", !curFilled);
    if(!curFilled) missing.push("mot de passe actuel");

    var newOk = newEl.value !== "";
    newEl.classList.toggle("input-error", !newOk);
    if(!newOk) missing.push("nouveau mot de passe");

    var strengthIssues = newOk ? passwordIssues(newEl.value) : [];
    if(newOk && strengthIssues.length){
      newEl.classList.add("input-error");
      missing.push("nouveau mot de passe trop faible (il doit contenir : " + strengthIssues.join(", ") + ")");
    }

    var confOk = newOk && confEl.value === newEl.value;
    confEl.classList.toggle("input-error", !confOk);
    if(newOk && !confOk) missing.push("confirmation (ne correspond pas)");

    if(missing.length){
      alert("Merci de corriger :\\n— " + missing.join("\\n— "));
      return;
    }
    try{
      var res = await apiFetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current: curEl.value, new_password: newEl.value })
      });
      var data = await res.json().catch(function(){ return {}; });
      if(!res.ok){
        curEl.classList.toggle("input-error", data.code === "bad_current");
        alert(data.message || "Le mot de passe n'a pas pu être modifié.");
        return;
      }
      closePwdModal();
      alert("Mot de passe modifié avec succès.");
    }catch(err){
      alert("Erreur de connexion au serveur.");
    }
  });`,
  },
  // ---------------------------------------------------------------- P6e
  {
    name: 'P6e — bouton régénération toujours visible (plus de dépendance à Web Crypto)',
    start: '      document.getElementById("twofa-manage-regenerate").style.display = TOTP_SUPPORTED ? "inline-flex" : "none";',
    end: '      document.getElementById("twofa-manage-regenerate").style.display = TOTP_SUPPORTED ? "inline-flex" : "none";',
    replacement: '      document.getElementById("twofa-manage-regenerate").style.display = "inline-flex";',
  },
  // ---------------------------------------------------------------- P7a
  {
    name: 'P7a — Paramètres : liste des accès depuis l\'API',
    start: '  function renderSettings(){',
    end: `    rBody.querySelectorAll("[data-reset-acc]").forEach(function(b){ b.addEventListener("click", function(){ resetAccountPassword(b.getAttribute("data-reset-acc")); }); });
  }`,
    replacement: `  var settingsAccounts = {};
  async function renderSettings(){
    var mBody = document.getElementById("settings-managers-body");
    var rBody = document.getElementById("settings-recruteurs-body");
    var mRows = [], rRows = [];
    settingsAccounts = {};
    var res;
    try{
      res = await apiFetch("/api/comptes", { method: "GET" });
    }catch(e){
      mBody.innerHTML = '<tr><td colspan="6" style="color:var(--red);">Chargement des accès impossible.</td></tr>';
      rBody.innerHTML = '<tr><td colspan="5" style="color:var(--red);">Chargement des accès impossible.</td></tr>';
      return;
    }
    if(!res.ok){
      mBody.innerHTML = '<tr><td colspan="6" style="color:var(--red);">Chargement des accès impossible.</td></tr>';
      rBody.innerHTML = '<tr><td colspan="5" style="color:var(--red);">Chargement des accès impossible.</td></tr>';
      return;
    }
    var data = await res.json().catch(function(){ return { accounts: [] }; });
    (data.accounts || []).forEach(function(a){
      settingsAccounts[a.username] = a;
      var statusBadge = a.activated
        ? '<span class="status-badge status-selected">Actif</span>'
        : '<span class="status-badge status-amber">En attente d\\'activation</span>';
      var actions = '<button class="btn-view" data-edit-acc="' + escapeHtml(a.username) + '">Modifier</button> ' +
        '<button class="btn-view" data-reset-acc="' + escapeHtml(a.username) + '">Réinitialiser le mot de passe</button> ' +
        '<button class="btn-view" data-del-acc="' + escapeHtml(a.username) + '">Supprimer</button>';
      if(a.role === "manager"){
        mRows.push('<tr><td class="name-cell">' + escapeHtml(a.username) + '</td><td>' + escapeHtml(a.nom || "—") + '</td><td>' + escapeHtml(a.prenom || "—") + '</td><td>' + escapeHtml(a.projet || "—") + '</td><td>' + statusBadge + '</td>' +
          '<td>' + actions + '</td></tr>');
      } else if(a.role === "recruteur"){
        rRows.push('<tr><td class="name-cell">' + escapeHtml(a.username) + '</td><td>' + escapeHtml(a.nom || "—") + '</td><td>' + escapeHtml(a.prenom || "—") + '</td><td>' + statusBadge + '</td>' +
          '<td>' + actions + '</td></tr>');
      }
    });
    mBody.innerHTML = mRows.join("") || '<tr><td colspan="6" style="color:var(--ink-soft);">Aucun accès manager pour l\\'instant.</td></tr>';
    rBody.innerHTML = rRows.join("") || '<tr><td colspan="5" style="color:var(--ink-soft);">Aucun accès recruteur pour l\\'instant.</td></tr>';

    mBody.querySelectorAll("[data-edit-acc]").forEach(function(b){ b.addEventListener("click", function(){ openAccountModal("manager", b.getAttribute("data-edit-acc")); }); });
    rBody.querySelectorAll("[data-edit-acc]").forEach(function(b){ b.addEventListener("click", function(){ openAccountModal("recruteur", b.getAttribute("data-edit-acc")); }); });
    mBody.querySelectorAll("[data-del-acc]").forEach(function(b){ b.addEventListener("click", function(){ deleteAccount(b.getAttribute("data-del-acc")); }); });
    rBody.querySelectorAll("[data-del-acc]").forEach(function(b){ b.addEventListener("click", function(){ deleteAccount(b.getAttribute("data-del-acc")); }); });
    mBody.querySelectorAll("[data-reset-acc]").forEach(function(b){ b.addEventListener("click", function(){ resetAccountPassword(b.getAttribute("data-reset-acc")); }); });
    rBody.querySelectorAll("[data-reset-acc]").forEach(function(b){ b.addEventListener("click", function(){ resetAccountPassword(b.getAttribute("data-reset-acc")); }); });
  }`,
  },
  // ---------------------------------------------------------------- P7b
  {
    name: 'P7b — suppression de compte (douce) via l\'API',
    start: '  function deleteAccount(u){',
    end: `    delete accounts[u];
    saveAccounts();
    renderSettings();
  }`,
    replacement: `  async function deleteAccount(u){
    if(!confirm("Supprimer l'accès « " + u + " » ? L'accès sera désactivé (le compte ne pourra plus se connecter) ; action réversible en base.")) return;
    var res = await apiFetch("/api/comptes/" + encodeURIComponent(u), { method: "DELETE" });
    if(!res.ok){ alert("Suppression impossible."); return; }
    renderSettings();
  }`,
  },
  // ---------------------------------------------------------------- P7c
  {
    name: 'P7c — réinitialisation du mot de passe via l\'API',
    start: '  function resetAccountPassword(u){',
    end: `    acc.pass = null;
    acc.activationToken = generateToken();
    saveAccounts();
    renderSettings();
    openActivationLinkModal(u, acc);
  }`,
    replacement: `  async function resetAccountPassword(u){
    if(!confirm("Générer un nouveau lien d'activation pour « " + u + " » ? Son mot de passe actuel sera désactivé jusqu'à ce qu'elle/il en définisse un nouveau.")) return;
    var res = await apiFetch("/api/comptes/" + encodeURIComponent(u) + "/reset", { method: "POST" });
    if(!res.ok){ alert("Réinitialisation impossible."); return; }
    var data = await res.json().catch(function(){ return {}; });
    renderSettings();
    openActivationLinkModal(data.email || u, data.link || "", data.prenom || "");
  }`,
  },
  // ---------------------------------------------------------------- P7d
  {
    name: 'P7d — modal édition : compte depuis le cache de la liste API',
    start: '    var acc = username ? accounts[username] : null;',
    end: '    var acc = username ? accounts[username] : null;',
    replacement: '    var acc = username ? (settingsAccounts[username] || null) : null;',
  },
  // ---------------------------------------------------------------- P7e
  {
    name: 'P7e — création/modification de compte via l\'API (lien d\'activation renvoyé par le serveur)',
    start: '  document.getElementById("account-modal-save").addEventListener("click", function(){',
    end: `    if(isNew) openActivationLinkModal(newKey, entry);
  });`,
    replacement: `  document.getElementById("account-modal-save").addEventListener("click", async function(){
    var uField = document.getElementById("acc-username");
    var nomField = document.getElementById("acc-nom");
    var prenomField = document.getElementById("acc-prenom");
    var emailField = document.getElementById("acc-email");
    var projetSel = document.getElementById("acc-projet");

    var u = uField.value.trim().toLowerCase();
    var nom = nomField.value.trim();
    var prenom = prenomField.value.trim();
    var email = emailField.value.trim();
    var projet = accModalRole === "manager" ? projetSel.value : "";

    var missing = [];
    var uFormatOk = isConcentrixEmail(u);
    uField.classList.toggle("input-error", !(u !== "" && uFormatOk));
    if(!(u !== "" && uFormatOk)){
      if(u === "") missing.push("identifiant");
      else missing.push("identifiant (doit être une adresse email @concentrix.com)");
    }

    var nomOk = nom !== "";
    nomField.classList.toggle("input-error", !nomOk);
    if(!nomOk) missing.push("nom");

    var prenomOk = prenom !== "";
    prenomField.classList.toggle("input-error", !prenomOk);
    if(!prenomOk) missing.push("prénom");

    var emailOk = email !== "" && email.indexOf("@") > 0;
    emailField.classList.toggle("input-error", !emailOk);
    if(!emailOk) missing.push("email");

    if(accModalRole === "manager"){
      var projetOk = projet !== "";
      projetSel.classList.toggle("input-error", !projetOk);
      if(!projetOk) missing.push("projet du ressort");
    }

    if(missing.length){
      alert("Merci de renseigner les champs obligatoires manquants :\\n— " + missing.join("\\n— "));
      return;
    }

    var payload = { username: u, role: accModalRole, nom: nom, prenom: prenom, email: email, projet: projet };
    try{
      var res;
      if(accModalEditing){
        res = await apiFetch("/api/comptes/" + encodeURIComponent(accModalEditing), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      }else{
        res = await apiFetch("/api/comptes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      }
      var data = await res.json().catch(function(){ return {}; });
      if(!res.ok){ alert(data.message || "Enregistrement impossible."); return; }
      renderSettings();
      closeAccountModal();
      if(!accModalEditing) openActivationLinkModal(email, data.link || "", prenom);
    }catch(err){
      alert("Erreur de connexion au serveur.");
    }
  });`,
  },
  // ---------------------------------------------------------------- P8
  {
    name: 'P8 — démarrage asynchrone (activation → session)',
    start: '  loadAccounts();',
    end: `  if(!checkActivationLink()){
    checkSession();
  }`,
    replacement: `  (async function boot(){
    loadSession();
    if(!await checkActivationLink()){
      await checkSession();
    }
  })();`,
  },
  // ---------------------------------------------------------------- P9
  {
    name: 'P9 — aide de connexion : suppression des identifiants affichés en clair',
    start: '    <div class="login-hint">',
    end: `      Cet écran filtre l'accès dans le navigateur ; il ne remplace pas une authentification serveur pour des données sensibles.
    </div>`,
    replacement: `    <div class="login-hint">
      L'identifiant de tout accès (administrateur, recruteur, manager) est une adresse email @concentrix.com.<br><br>
      Les accès Recruteur et Manager (identifiant, nom, prénom, email, et projet du ressort pour les managers) sont créés par l'administrateur (RH) depuis Paramètres. Un lien d'activation permet ensuite à chacun de définir lui-même son mot de passe.<br><br>
      Un manager ne voit que les candidats du pré-vivier affectés par le recruteur au projet fixé sur son accès.<br><br>
      La double authentification (code à 6 chiffres via une application d'authentification) est obligatoire : elle vous sera demandée dès la première connexion, puis à chaque connexion. Elle est gérable depuis « Double authentification » une fois connecté.
    </div>`,
  },
];

function applyPatch(content, p) {
  const si = content.indexOf(p.start);
  if (si === -1) throw new Error(`[${p.name}] marqueur de DÉBUT introuvable`);
  if (content.indexOf(p.start, si + 1) !== -1) throw new Error(`[${p.name}] marqueur de début NON UNIQUE`);
  const firstEnd = content.indexOf(p.end);
  const ei = content.indexOf(p.end, si);
  if (ei === -1) throw new Error(`[${p.name}] marqueur de FIN introuvable après le début`);
  if (content.indexOf(p.end, ei + p.end.length) !== -1) throw new Error(`[${p.name}] marqueur de fin NON UNIQUE`);
  if (p.start !== p.end && firstEnd < si) throw new Error(`[${p.name}] ordre marqueurs invalide`);
  return content.slice(0, si) + p.replacement + content.slice(ei + p.end.length);
}

for (const p of patches) {
  content = applyPatch(content, p);
  console.log(`  ✓ ${p.name}`);
}

// ---- Vérifications post-patch ----
const forbidden = [
  ['comptes en clair', /recrutement2026|recruteur2026|manager2026/],
  ['aide avec identifiants démo', /admin@concentrix\.com/],
  ['comptes localStorage', /\bACCOUNTS_KEY\b|\bloadAccounts\b|\bsaveAccounts\b|\bDEFAULT_ACCOUNTS\b|\baccounts\[/],
  ['sessionStockage', /sessionStorage|recrutement_session_v7/],
  ['variables de session', /\bSESSION_KEY\b/],
  ['TOTP côté client', /\bTOTP_SUPPORTED\b|\btotpCodeAt\b|\bverifyTotpCode\b|\brandomBase32Secret\b|\bbase32ToBytes\b|\bintToBytes\b|\bbuildOtpauthUri\b|crypto\.subtle/],
  ['anciens flux', /\bstartTwoFactorStep\b|\bfinalizeLogin\b|\bapplyAccount\b|\bfindAccountByToken\b|\bgenerateToken\b|\bactivationUsername\b|\btwofaPendingUser\b|\btwofaPendingSecret\b/],
];
let issues = 0;
for (const [label, re] of forbidden) {
  const m = content.match(re);
  if (m) {
    issues++;
    const idx = m.index ?? content.search(re);
    console.log(`  ✗ résidu détecté [${label}] : ${m[0]} (position ${idx})`);
  }
}

// Syntaxe du <script> inline (le 2e bloc, sans src)
const inlineMatch = content.match(/<script>([\s\S]*?)<\/script>/);
if (!inlineMatch) throw new Error('bloc <script> inline introuvable');
try {
  new Function(inlineMatch[1]);
  console.log('  ✓ syntaxe du <script> inline valide');
} catch (e) {
  issues++;
  console.log('  ✗ erreur de syntaxe dans le script inline :', e.message);
}

if (issues > 0) {
  console.error(`\n✗ ${issues} problème(s) — fichier NON modifié.`);
  process.exit(1);
}
fs.writeFileSync(FILE, content);
console.log(`\n✓ Front migré : ${FILE} (${content.split('\n').length} lignes)`);
