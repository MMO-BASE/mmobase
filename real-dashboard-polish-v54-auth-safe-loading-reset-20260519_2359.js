console.log("MMOBASE frontend build: polish-v54-auth-safe-loading-reset-20260519_2359");
// MMOBASE Real Dashboard - Live ESI Data
// Uses supabaseClient already declared by the page

var currentCharacterId = null;
var linkedCharacters = [];
var accessToken = null;
var nameCache = {};

// Format ISK values
function formatISK(amount) {
  if (amount === null || amount === undefined) return '0.000 ISK';
  var n = parseFloat(amount);
  if (!Number.isFinite(n)) return '0.000 ISK';
  if (n >= 1000000000000) return (n / 1000000000000).toFixed(3) + 'T ISK';
  if (n >= 1000000000) return (n / 1000000000).toFixed(3) + 'B ISK';
  if (n >= 1000000) return (n / 1000000).toFixed(3) + 'M ISK';
  if (n >= 1000) return (n / 1000).toFixed(3) + 'K ISK';
  return n.toFixed(3) + ' ISK';
}


function formatAssetChangeOrCountdown(changeValue, daysLeft, periodDays) {
  if (changeValue !== null && changeValue !== undefined) return formatISK(changeValue);

  if (daysLeft !== null && daysLeft !== undefined && !isNaN(daysLeft) && daysLeft > 0) {
    return daysLeft === 1 ? "Ready tomorrow" : daysLeft + "d until ready";
  }

  // Fallback: if backend countdown fields are missing, keep a browser-side
  // tracking start date so the user still sees a useful countdown.
  try {
    var key = "mmobase-assets-tracking-started";
    var started = localStorage.getItem(key);
    if (!started) {
      started = new Date().toISOString();
      localStorage.setItem(key, started);
    }

    var ageDays = Math.floor((new Date() - new Date(started)) / 86400000);
    var remaining = Math.max(1, periodDays - ageDays);
    return remaining === 1 ? "Ready tomorrow" : remaining + "d until ready";
  } catch (e) {
    return "Collecting data";
  }
}

// Format numbers with commas
function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return parseInt(num).toLocaleString();
}

// Format time remaining
function formatTimeRemaining(finishDate) {
  if (!finishDate) return "Paused";
  var diff = new Date(finishDate) - new Date();
  if (diff <= 0) return 'Complete';
  var days = Math.floor(diff / 86400000);
  var hours = Math.floor((diff % 86400000) / 3600000);
  var mins = Math.floor((diff % 3600000) / 60000);
  return (days > 0 ? days + 'd ' : '') + hours + 'h ' + mins + 'm';
}

function formatDurationRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0h 0m";
  var days = Math.floor(ms / 86400000);
  var hours = Math.floor((ms % 86400000) / 3600000);
  var mins = Math.floor((ms % 3600000) / 60000);
  return (days > 0 ? days + 'd ' : '') + hours + 'h ' + mins + 'm';
}

function getSkillIndividualRemaining(skill, isActive, isPaused) {
  if (!skill) return "-";
  if (isPaused) return "Paused";

  // Active skill: remaining time is from now until it finishes.
  if (isActive) return skill.finish_date ? formatTimeRemaining(skill.finish_date) : "Paused";

  // Queued skills: remaining time for this skill only is finish - start,
  // not the cumulative queue time from now.
  if (skill.start_date && skill.finish_date) {
    var duration = new Date(skill.finish_date) - new Date(skill.start_date);
    return formatDurationRemaining(duration);
  }

  // Fallback if ESI does not provide start_date for a queued item.
  return skill.finish_date ? formatTimeRemaining(skill.finish_date) : "Queued";
}

// Resolve ESI IDs to names (types, systems, stations etc)
async function resolveNames(ids) {
  if (!ids) return {};
  var uncached = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (id && id > 0 && !nameCache[id]) uncached.push(id);
  }
  if (uncached.length === 0) return nameCache;
  try {
    var resp = await fetch("https://esi.evetech.net/latest/universe/names/?datasource=tranquility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uncached.slice(0, 1000))
    });
    if (resp.ok) {
      var names = await resp.json();
      for (var j = 0; j < names.length; j++) {
        nameCache[names[j]["id"]] = names[j]["name"];
      }
    }
  } catch(e) {}
  var still = uncached.filter(function(id) { return !nameCache[id]; });
  for (var k = 0; k < still.length; k++) {
    try {
      var r = await fetch("https://esi.evetech.net/latest/universe/types/" + still[k] + "/?datasource=tranquility");
      if (r.ok) { var t = await r.json(); nameCache[still[k]] = t["name"]; }
    } catch(e) {}
  }
  return nameCache;
}

// Resolve a single type ID
async function resolveTypeName(typeId) {
  if (nameCache[typeId]) return nameCache[typeId];
  try {
    var resp = await fetch('https://esi.evetech.net/latest/universe/types/' + typeId + '/?datasource=tranquility');
    if (resp.ok) {
      var data = await resp.json();
      nameCache[typeId] = data.name;
      return data.name;
    }
  } catch(e) {}
  return 'Unknown (ID: ' + typeId + ')';
}

// Initialize dashboard
async function initDashboard() {
  var session = await supabaseClient.auth.getSession();
  if (!session.data.session) {
    window.location.href = '/dashboard';
    return;
  }
  accessToken = session.data.session.access_token;

  // Update nav
  var user = session.data.session.user;
  var authBtn = document.getElementById('authButton');
  if (authBtn) {
    authBtn.textContent = 'Hi, ' + (user.user_metadata.full_name || 'User').split(' ')[0];
    authBtn.onclick = function(e) { toggleDropdown(e); };
  }

  // Fetch linked characters
  try {
    var resp = await fetch('/api/characters', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    var data = await resp.json();
    linkedCharacters = data.characters || [];
  } catch(e) {
    linkedCharacters = [];
  }

  if (linkedCharacters.length === 0) {
    showToast('No EVE characters linked. Redirecting to settings...', 'info');
    setTimeout(function() { window.location.href = '/settings'; }, 2000);
    return;
  }

  // Build character switcher
  buildCharacterSwitcher();

  // Load primary character
  var primary = getPreferredCharacter();

  if (characterNeedsRelink(primary)) {
    showToast('Your linked EVE character needs re-linking. Redirecting to settings...', 'error');
    setTimeout(function() { window.location.href = '/settings'; }, 1500);
    return;
  }

  loadCharacterData(primary.character_id);
  loadJitaPrices();
}

// Build the character switcher dropdown

function safeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function characterNeedsRelink(ch) {
  return !!(ch && (ch.needs_relink === true || ch.token_status === "needs_relink"));
}

function getPreferredCharacter() {
  return linkedCharacters.find(function(c) {
    return !characterNeedsRelink(c) && c.is_primary;
  }) || linkedCharacters.find(function(c) {
    return !characterNeedsRelink(c);
  }) || linkedCharacters[0];
}

async function relinkEveCharacter(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  try {
    var sessionResult = await supabaseClient.auth.getSession();
    var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;

    if (!session) {
      window.location.href = "/settings";
      return;
    }

    window.location.href = "/auth/eve?token=" + encodeURIComponent(session.access_token) + "&from=settings";
  } catch (e) {
    window.location.href = "/settings";
  }
}


function buildCharacterSwitcher() {
  var switcher = document.querySelector('.char-switcher-btn');
  var dropdown = document.getElementById('charDropdown');

  if (!switcher || !dropdown) return;

  var primary = getPreferredCharacter();
  if (!primary) return;
  switcher.innerHTML = safeHtml(primary.character_name) + ' <svg viewBox="0 0 10 10" style="width:10px;height:10px;fill:currentColor"><path d="M1 3 L5 7 L9 3 Z"/></svg>';

  var html = '<div class="char-dropdown-label">Your Characters</div>';
  linkedCharacters.forEach(function(ch, i) {
    var needsRelink = characterNeedsRelink(ch);
    var isActive = primary && ch.character_id === primary.character_id;
    var clickAction = needsRelink ? 'relinkEveCharacter(event)' : 'switchToCharacter(' + ch.character_id + ', this, event)';

    html += '<a class="char-item' + (isActive ? ' active' : '') + (needsRelink ? ' needs-relink' : '') + '" onclick="' + clickAction + '">';
    html += '<span class="char-item-dot" style="' + (needsRelink ? 'background:#f59e0b;' : '') + '"></span>';
    html += '<span>' + safeHtml(ch.character_name);

    if (needsRelink) {
      html += ' <em style="margin-left:8px;color:#f59e0b;font-style:normal;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;">Needs re-link</em>';
    }

    html += '</span>';
    html += '</a>';
  });
  html += '<hr>';
  html += '<a href="/settings" class="char-connect-new">';
  html += '<svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  html += 'Connect Another Account';
  html += '</a>';

  dropdown.innerHTML = html;
}

// Switch to a different character
function switchToCharacter(characterId, el, event) {
  event.preventDefault();
  event.stopPropagation();

  var ch = linkedCharacters.find(function(c) { return c.character_id === characterId; });

  if (characterNeedsRelink(ch)) {
    showToast('This character needs re-linking with EVE.', 'error');
    relinkEveCharacter(event);
    return;
  }

  if (ch) {
    document.querySelector('.char-switcher-btn').innerHTML = ch.character_name + ' <svg viewBox="0 0 10 10" style="width:10px;height:10px;fill:currentColor"><path d="M1 3 L5 7 L9 3 Z"/></svg>';
  }

  document.querySelectorAll('.char-item').forEach(function(item) { item.classList.remove('active'); });
  if (el) el.classList.add('active');
  document.getElementById('charDropdown').classList.remove('show');
  loadCharacterData(characterId);
}


function resetDashboardLoadingState() {
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  var loading = "Loading...";

  // Overview loading states
  [
    "overview-char-name", "overview-char-corp", "overview-char-alliance",
    "overview-skill-points", "overview-security-status", "overview-current-ship", "overview-location",
    "overview-today-net", "overview-today-income", "overview-today-outgoing",
    "overview-training-name", "overview-training-level", "overview-training-time",
    "overview-wallet-balance", "overview-wallet-today", "overview-wallet-week", "overview-wallet-month",
    "overview-asset-value", "overview-asset-stations", "overview-asset-ships", "overview-asset-7d", "overview-asset-30d",
    "overview-net-worth", "overview-net-wallet", "overview-net-assets", "overview-net-30d"
  ].forEach(function(id) { setText(id, loading); });

  setText("overview-today-label", "Net change today");
  setHtml("overview-training-queue", '<div class="queue-item"><span><span class="queue-item-name">Loading queue...</span></span><span class="queue-item-time"></span></div>');
  var overviewBar = document.getElementById("overview-training-bar");
  if (overviewBar) overviewBar.style.width = "0%";

  // Training loading states
  setText("training-pct", loading);
  setText("training-finish", loading);
  setText("ts-queuelen", loading);
  setText("queue-title", "Skill Queue");
  setHtml("skill-queue-container", '<p style="font-size:13px;color:var(--t2);padding:8px 0;">Loading skill queue...</p>');

  document.querySelectorAll("#tab-training .training-skill-name").forEach(function(el) { el.textContent = loading; });
  document.querySelectorAll("#tab-training .training-level").forEach(function(el) { el.textContent = ""; });
  document.querySelectorAll("#tab-training .training-time").forEach(function(el) { el.textContent = loading; });
  document.querySelectorAll("#tab-training .training-bar-fill").forEach(function(el) { el.style.width = "0%"; });

  // Finance loading states
  [
    "finance-wallet-balance", "finance-wallet-today", "finance-wallet-week", "finance-wallet-month",
    "finance-pnl-today-net", "finance-pnl-today-income", "finance-pnl-today-outgoing",
    "finance-avg-daily-income", "finance-avg-daily-expenses", "finance-avg-daily-profit", "finance-avg-best-day", "finance-avg-worst-day",
    "wallet-chart-current", "wallet-chart-change"
  ].forEach(function(id) { setText(id, loading); });

  setText("finance-pnl-today-label", "Net change today");
  setText("wallet-chart-change-label", "Status");
  var walletLine = document.getElementById("wallet-balance-line");
  if (walletLine) walletLine.setAttribute("points", "");
  setHtml("wallet-balance-points", "");

  // Assets loading states
  [
    "assets-total-value", "assets-stations", "assets-ships", "assets-change-7d", "assets-change-14d", "assets-change-30d",
    "asset-chart-current", "asset-chart-change"
  ].forEach(function(id) { setText(id, loading); });

  setText("asset-chart-change-label", "Status");
  setText("asset-station-view-title", "Loading location contents...");
  setHtml("asset-locations-container", '<p style="font-size:13px;color:var(--t2);padding:8px 0;">Loading asset locations...</p>');
  setHtml("asset-location-items-container", '<p style="font-size:13px;color:var(--t2);padding:8px 0;">Loading location contents...</p>');

  var assetLine = document.getElementById("asset-value-line");
  if (assetLine) assetLine.setAttribute("points", "");
  setHtml("asset-value-points", "");

  // Market and fleet loading states
  ["mkt-buy-count", "mkt-sell-count", "mkt-buy-isk", "mkt-sell-isk", "mkt-escrow"].forEach(function(id) { setText(id, loading); });
  setHtml("jita-prices-container", '<p style="font-size:13px;color:var(--t2);text-align:center;padding:34px 0;">Loading prices...</p>');
  setHtml("fleet-members-container", '<p style="font-size:13px;color:var(--t2);padding:8px 0;">Loading fleet...</p>');
  setHtml("fleet-comp-container", '<p style="font-size:13px;color:var(--t2);padding:8px 0;">Loading fleet composition...</p>');
}


// Load character data from API
async function loadCharacterData(characterId) {
  currentCharacterId = characterId;
  resetDashboardLoadingState();
  showToast('Loading character data...', 'loading', { sticky: true });

  try {
    var resp = await fetch('/api/character/' + characterId + '/data', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    var data = await resp.json();

    if (data.error) {
      showToast('Error: ' + data.error, 'error', { duration: 7000 });
      return;
    }

    var idsToResolve = [];
    if (data.location) idsToResolve.push(data["location"]["solar_system_id"]);
    if (data.ship) idsToResolve.push(data.ship.ship_type_id);
    await resolveNames(idsToResolve);
    var skillIds = [];
    if (data.skillqueue) { data.skillqueue.forEach(function(s) { if (s.skill_id > 0) skillIds.push(s.skill_id); }); }
    var orderIds = [];
    if (data.orders) { data.orders.forEach(function(o) { if (o.type_id > 0) orderIds.push(o.type_id); }); }
    if (skillIds.length > 0) { await resolveNames(skillIds); }
    if (orderIds.length > 0) { await resolveNames(orderIds); }
    await resolveNames(idsToResolve);

    populateOverview(data);
    populateTraining(data);
    populateFinance(data);
    populateAssets(data);
    populateMarket(data);
    populateFleet(data);

    showToast('Character data loaded.', 'success', { duration: 2500 });

  } catch(e) {
    showToast('Failed to load character data.', 'error', { duration: 7000 });
    console.error(e);
  }
}


var assetValueHistory = [];
var selectedAssetValueRange = 7;
var walletBalanceHistory = [];
var selectedWalletBalanceRange = 7;

function setAssetValueRange(days, btn) {
  selectedAssetValueRange = days;

  document.querySelectorAll(".asset-range-btn").forEach(function(b) {
    b.classList.remove("active");
    b.style.background = "transparent";
    b.style.color = "var(--t3)";
  });

  if (btn) {
    btn.classList.add("active");
    btn.style.background = "var(--adim)";
    btn.style.color = "var(--acc)";
  }

  renderAssetValueChart(days);
}


function formatAssetChartDate(value) {
  try {
    return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch (e) {
    return "";
  }
}






function svgEscapeText(value) {
  return String(value || "").replace(/[&<>"']/g, function(ch) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch];
  });
}

function showAssetSvgTooltip(target) {
  var svg = document.getElementById("asset-value-svg");
  if (!svg || !target) return;

  var value = Number(target.getAttribute("data-value") || 0);
  var dateText = target.getAttribute("data-date") || "";
  var valueText = formatISK(value);

  var cx = parseFloat(target.getAttribute("cx") || "0");
  var cy = parseFloat(target.getAttribute("cy") || "0");

  var viewBox = svg.getAttribute("viewBox") || "0 0 600 135";
  var parts = viewBox.split(/\s+/).map(Number);
  var chartWidth = parts[2] || 600;
  var chartHeight = parts[3] || 135;

  var tooltip = document.getElementById("asset-value-svg-tooltip");
  if (!tooltip) {
    tooltip = document.createElementNS("http://www.w3.org/2000/svg", "g");
    tooltip.setAttribute("id", "asset-value-svg-tooltip");
    tooltip.setAttribute("pointer-events", "none");
    svg.appendChild(tooltip);
  }

  var boxWidth = Math.max(132, Math.max(valueText.length * 8, dateText.length * 6) + 26);
  var boxHeight = 44;
  var x = cx + 14;
  var y = cy - boxHeight - 12;

  if (x + boxWidth > chartWidth - 8) x = cx - boxWidth - 14;
  if (x < 8) x = 8;
  if (y < 8) y = cy + 16;
  if (y + boxHeight > chartHeight - 8) y = chartHeight - boxHeight - 8;

  tooltip.innerHTML =
    '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + boxWidth.toFixed(1) + '" height="' + boxHeight + '" rx="10" fill="#0a0e17" fill-opacity="0.98" stroke="#00b4d8" stroke-opacity="0.38"></rect>' +
    '<text x="' + (x + 12).toFixed(1) + '" y="' + (y + 18).toFixed(1) + '" fill="#00b4d8" style="font-family:JetBrains Mono, monospace;font-size:13px;font-weight:700;">' + svgEscapeText(valueText) + '</text>' +
    '<text x="' + (x + 12).toFixed(1) + '" y="' + (y + 34).toFixed(1) + '" fill="#555d6e" style="font-family:Inter, sans-serif;font-size:10px;font-weight:600;letter-spacing:0.7px;text-transform:uppercase;">' + svgEscapeText(dateText) + '</text>';

  tooltip.style.display = "block";
}

function hideAssetSvgTooltip() {
  var tooltip = document.getElementById("asset-value-svg-tooltip");
  if (tooltip) tooltip.style.display = "none";
}

function assetPointSvg(x, y, row) {
  var dateText = formatAssetChartDate(row.created_at).replace(/"/g, "&quot;");
  var value = Number(row.total_value || 0);
  var dataAttrs = ' data-value="' + value + '" data-date="' + dateText + '"';

  return '<g>' +
    '<circle class="asset-chart-hit" cx="' + x + '" cy="' + y + '" r="16" fill="transparent" stroke="transparent" pointer-events="all" onmousemove="showAssetSvgTooltip(this)" onmouseleave="hideAssetSvgTooltip()"' + dataAttrs + '></circle>' +
    '<circle class="asset-chart-point" cx="' + x + '" cy="' + y + '" r="6" fill="var(--acc)" stroke="var(--bg)" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="all" style="cursor:pointer;" onmousemove="showAssetSvgTooltip(this)" onmouseleave="hideAssetSvgTooltip()"' + dataAttrs + '></circle>' +
    '</g>';
}

function renderAssetValueChart(days) {
  var svgLine = document.getElementById("asset-value-line");
  var pointsGroup = document.getElementById("asset-value-points");
  var currentEl = document.getElementById("asset-chart-current");
  var changeEl = document.getElementById("asset-chart-change");
  var changeLabel = document.getElementById("asset-chart-change-label");
  var startLabel = document.getElementById("asset-chart-start-label");

  if (!svgLine || !pointsGroup) return;

  var svg = svgLine.ownerSVGElement;
  var chartWidth = 600;
  var chartHeight = 135;

  if (svg) {
    var rect = svg.getBoundingClientRect();
    chartWidth = rect.width && rect.width > 0 ? rect.width : 600;
    chartHeight = rect.height && rect.height > 0 ? rect.height : 135;
    svg.setAttribute("viewBox", "0 0 " + chartWidth + " " + chartHeight);
  }

  if (startLabel) startLabel.textContent = days + " days ago";

  var history = (assetValueHistory || []).filter(function(row) {
    return row && row.created_at && row.total_value !== null && row.total_value !== undefined;
  }).sort(function(a, b) {
    return new Date(a.created_at) - new Date(b.created_at);
  });

  pointsGroup.innerHTML = "";
  svgLine.setAttribute("points", "");
  hideAssetSvgTooltip();

  if (history.length < 1) {
    if (changeLabel) changeLabel.textContent = "Status";
    if (changeEl) {
      changeEl.textContent = "Building " + days + "-day history";
      changeEl.style.color = "";
    }
    pointsGroup.innerHTML = '<text x="' + (chartWidth / 2).toFixed(1) + '" y="' + (chartHeight / 2).toFixed(1) + '" text-anchor="middle" fill="var(--t2)" style="font-size:13px;font-family:Inter,sans-serif;">Current value will appear after first snapshot</text>';
    return;
  }

  if (currentEl) currentEl.textContent = formatISK(history[history.length - 1].total_value);

  function dateKey(d) {
    return d.toISOString().slice(0, 10);
  }

  var byDay = {};
  history.forEach(function(row) {
    var key = dateKey(new Date(row.created_at));
    if (!byDay[key] || new Date(row.created_at) > new Date(byDay[key].created_at)) {
      byDay[key] = row;
    }
  });

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var dailyRows = [];
  var firstKnown = history.length ? history[0] : null;
  var lastKnown = null;
  var realDayCount = 0;

  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(today.getTime() - i * 86400000);
    var key = dateKey(d);
    var source = byDay[key];

    if (source) {
      realDayCount += 1;
      lastKnown = source;
    } else if (!lastKnown) {
      for (var h = history.length - 1; h >= 0; h--) {
        if (dateKey(new Date(history[h].created_at)) <= key) {
          lastKnown = history[h];
          break;
        }
      }
      source = lastKnown || firstKnown;
    } else {
      source = lastKnown;
    }

    if (!source && firstKnown) source = firstKnown;

    if (source) {
      dailyRows.push({
        created_at: d.toISOString(),
        day_key: key,
        total_value: Number(source.total_value || 0),
        carried_forward: !byDay[key]
      });
    }
  }

  var hasFullHistory = realDayCount >= days;

  if (!hasFullHistory) {
    if (changeLabel) changeLabel.textContent = "Status";
    if (changeEl) {
      changeEl.textContent = "Building " + days + "-day history";
      changeEl.style.color = "";
    }
  } else {
    if (changeLabel) changeLabel.textContent = days + "d Change";
  }

  var leftPad = 18;
  var rightPad = 18;
  var topPad = 12;
  var bottomPad = 18;
  var usableWidth = chartWidth - leftPad - rightPad;
  var usableHeight = chartHeight - topPad - bottomPad;

  if (dailyRows.length === 1) {
    var singleX = (chartWidth / 2).toFixed(1);
    var singleY = (topPad + usableHeight / 2).toFixed(1);
    pointsGroup.innerHTML = assetPointSvg(singleX, singleY, dailyRows[0]);
    return;
  }

  var values = dailyRows.map(function(row) { return Number(row.total_value || 0); });
  var minVal = Math.min.apply(null, values);
  var maxVal = Math.max.apply(null, values);

  if (minVal === maxVal) {
    minVal = minVal * 0.98;
    maxVal = maxVal * 1.02;
  }

  var points = dailyRows.map(function(row, i) {
    var x = leftPad + (i / (dailyRows.length - 1)) * usableWidth;
    var value = Number(row.total_value || 0);
    var y = topPad + (1 - ((value - minVal) / (maxVal - minVal))) * usableHeight;
    return { x: x, y: y, row: row };
  });

  svgLine.setAttribute("points", points.map(function(p) {
    return p.x.toFixed(1) + "," + p.y.toFixed(1);
  }).join(" "));

  var circles = "";
  points.forEach(function(p) {
    circles += assetPointSvg(p.x.toFixed(1), p.y.toFixed(1), p.row);
  });
  pointsGroup.innerHTML = circles;

  if (hasFullHistory) {
    var first = dailyRows[0];
    var last = dailyRows[dailyRows.length - 1];
    var change = Number(last.total_value || 0) - Number(first.total_value || 0);

    if (changeEl) {
      changeEl.textContent = (change > 0 ? "+" : "") + formatISK(change);
      changeEl.style.color = change > 0 ? "var(--g)" : change < 0 ? "var(--r)" : "";
    }
  }
}

// Populate Overview tab
function populateOverview(data) {
  data = data || {};
  var ch = data.character || {};

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setColor(id, amount) {
    var el = document.getElementById(id);
    if (!el) return;
    var n = Number(amount || 0);
    el.style.color = n > 0 ? "var(--g)" : n < 0 ? "var(--r)" : "var(--t2)";
  }

  function signedISK(amount) {
    var n = Number(amount || 0);
    return (n > 0 ? "+" : n < 0 ? "-" : "") + formatISK(Math.abs(n));
  }

  function setSignedISK(id, amount, suffix) {
    setText(id, signedISK(amount) + (suffix || ""));
    setColor(id, amount);
  }

  function startOfTodayOverview() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function startOfWeekOverview() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    var day = d.getDay();
    var diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    return d;
  }

  function startOfMonthOverview() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d;
  }

  function walletBreakdownSince(journal, startDate) {
    var result = { income: 0, outgoing: 0, net: 0 };
    journal = Array.isArray(journal) ? journal : [];

    journal.forEach(function(row) {
      if (!row || row.amount === null || row.amount === undefined || !row.date) return;

      var date = new Date(row.date);
      if (isNaN(date.getTime()) || date < startDate) return;

      var amount = Number(row.amount || 0);
      result.net += amount;
      if (amount > 0) result.income += amount;
      if (amount < 0) result.outgoing += Math.abs(amount);
    });

    return result;
  }

  function sumJournalSince(journal, startDate) {
    return walletBreakdownSince(journal, startDate).net;
  }

  function assetChangeText(changeValue, daysLeft, days) {
    if (changeValue !== null && changeValue !== undefined) return signedISK(changeValue);
    if (daysLeft !== null && daysLeft !== undefined && !isNaN(daysLeft) && daysLeft > 0) {
      return daysLeft === 1 ? "Ready tomorrow" : daysLeft + "d until ready";
    }
    return "Building " + days + "d history";
  }

  // Character
  setText("overview-char-name", ch.character_name || "Unknown character");
  setText("overview-char-corp", ch.corporation_name || "");
  setText("overview-char-alliance", ch.alliance_name || "");

  var portrait = document.getElementById("overview-char-portrait");
  if (portrait && ch.portrait_url) {
    portrait.innerHTML = '<img src="' + ch.portrait_url + '" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;">';
  }

  setText("overview-skill-points", data.skills && data.skills.total_sp !== undefined ? formatNumber(data.skills.total_sp) : "0");
  setText("overview-security-status", data.security_status !== null && data.security_status !== undefined ? Number(data.security_status).toFixed(1) : "0.0");

  if (data.ship && data.ship.ship_type_id) {
    setText("overview-current-ship", nameCache[data.ship.ship_type_id] || ("Ship ID: " + data.ship.ship_type_id));
  } else {
    setText("overview-current-ship", "Unknown");
  }

  if (data.location && data.location.solar_system_id) {
    var sysId = data.location.solar_system_id;
    setText("overview-location", nameCache[sysId] || ("System: " + sysId));
  } else {
    setText("overview-location", "Unknown");
  }
// Today's Summary
  var journal = Array.isArray(data.wallet_journal) ? data.wallet_journal : [];
  var today = walletBreakdownSince(journal, startOfTodayOverview());

  setSignedISK("overview-today-net", today.net, "");
  setText("overview-today-label", today.net > 0 ? "Net profit today" : today.net < 0 ? "Net loss today" : "Net change today");

  setText("overview-today-income", "+" + formatISK(today.income));
  setColor("overview-today-income", today.income);

  setText("overview-today-outgoing", "-" + formatISK(today.outgoing));
  var outgoingEl = document.getElementById("overview-today-outgoing");
  if (outgoingEl) outgoingEl.style.color = today.outgoing > 0 ? "var(--r)" : "var(--t2)";

  // Training
  var rawQueue = Array.isArray(data.skillqueue) ? data.skillqueue : [];
  var now = new Date();
  var queue = rawQueue.filter(function(s) {
    if (!s.finish_date) return true;
    return new Date(s.finish_date) > now;
  });

  var current = queue.length > 0 ? queue[0] : null;

  if (current) {
    setText("overview-training-name", nameCache[current.skill_id] || ("Skill ID: " + current.skill_id));
    setText("overview-training-level", current.finished_level || "");
    setText("overview-training-time", current.finish_date ? formatTimeRemaining(current.finish_date) : "Paused");

    var bar = document.getElementById("overview-training-bar");
    if (bar && current.start_date && current.finish_date) {
      var total = new Date(current.finish_date) - new Date(current.start_date);
      var elapsed = new Date() - new Date(current.start_date);
      var pct = total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0;
      bar.style.width = pct.toFixed(1) + "%";
    }
  } else {
    setText("overview-training-name", "No active training");
    setText("overview-training-level", "");
    setText("overview-training-time", "Queue empty");
    var emptyBar = document.getElementById("overview-training-bar");
    if (emptyBar) emptyBar.style.width = "0%";
  }

  var queueContainer = document.getElementById("overview-training-queue");
  if (queueContainer) {
    // Overview shows the active skill plus the next 4 queued skills.
    var upNext = queue.slice(current ? 1 : 0, current ? 5 : 4);
    if (!upNext.length) {
      queueContainer.innerHTML = '<div class="queue-item"><span><span class="queue-item-name">No queued skills</span></span><span class="queue-item-time"></span></div>';
    } else {
      var qHtml = "";
      upNext.forEach(function(item) {
        qHtml += '<div class="queue-item"><span><span class="queue-item-name">' +
          (nameCache[item.skill_id] || ("Skill ID: " + item.skill_id)) +
          '</span><span class="queue-item-level">' + (item.finished_level || "") +
          '</span></span><span class="queue-item-time">' +
          (item.finish_date ? formatTimeRemaining(item.finish_date) : "Paused") +
          '</span></div>';
      });
      queueContainer.innerHTML = qHtml;
    }
  }

  // Wallet Balance
  var wallet = data.wallet !== null && data.wallet !== undefined ? Number(data.wallet || 0) : 0;
  setText("overview-wallet-balance", formatISK(wallet));
  setSignedISK("overview-wallet-today", sumJournalSince(journal, startOfTodayOverview()), " today");
  setSignedISK("overview-wallet-week", sumJournalSince(journal, startOfWeekOverview()), "");
  setSignedISK("overview-wallet-month", sumJournalSince(journal, startOfMonthOverview()), "");

  // Assets
  var assetSummary = data.asset_summary || {};
  var assetValue = Number(assetSummary.total_asset_value || 0);
  setText("overview-asset-value", assetSummary.total_asset_value !== null && assetSummary.total_asset_value !== undefined ? formatISK(assetValue) : "Calculating...");
  setText("overview-asset-stations", formatNumber(assetSummary.stations || 0));
  setText("overview-asset-ships", formatNumber(assetSummary.ships || 0));

  setText("overview-asset-7d", assetChangeText(assetSummary.change_7d, assetSummary.days_until_7d_change, 7));
  setColor("overview-asset-7d", assetSummary.change_7d || 0);

  setText("overview-asset-30d", assetChangeText(assetSummary.change_30d, assetSummary.days_until_30d_change, 30));
  setColor("overview-asset-30d", assetSummary.change_30d || 0);

  // Net Worth Snapshot
  var netWorth = wallet + assetValue;
  setText("overview-net-worth", formatISK(netWorth));
  setText("overview-net-wallet", formatISK(wallet));
  setText("overview-net-assets", formatISK(assetValue));

  var walletSummary = data.wallet_summary || {};
  var wallet30 = walletSummary.change_30d;
  var asset30 = assetSummary.change_30d;
  var net30Known = wallet30 !== null && wallet30 !== undefined && asset30 !== null && asset30 !== undefined;

  if (net30Known) {
    var net30 = Number(wallet30 || 0) + Number(asset30 || 0);
    setText("overview-net-30d", signedISK(net30));
    setColor("overview-net-30d", net30);
  } else {
    var assetDays = assetSummary.days_until_30d_change;
    var walletDays = walletSummary.days_until_30d_change;
    var daysLeft = Math.max(
      assetDays !== null && assetDays !== undefined ? Number(assetDays) : 0,
      walletDays !== null && walletDays !== undefined ? Number(walletDays) : 0
    );

    setText("overview-net-30d", daysLeft > 0 ? (daysLeft + "d until ready") : "Building history");
    var net30El = document.getElementById("overview-net-30d");
    if (net30El) net30El.style.color = "var(--t2)";
  }
}

// Populate Training tab
function populateTraining(data) {
  if (!data.skillqueue) return;
  var rawQueue = data.skillqueue || [];
  var now = new Date();

  // ESI can briefly return skills that have technically completed but are still present in the queue.
  // Filter completed entries out so the dashboard shows the real current/remaining queue.
  var queue = rawQueue.filter(function(s) {
    if (!s.finish_date) return true; // paused/unknown finish date
    return new Date(s.finish_date) > now;
  });

  var current = queue.length > 0 ? queue[0] : null;
  var isPaused = current && !current.finish_date;

  var trainingPanels = document.querySelectorAll('#tab-training .panel');

  // Currently training (wide panel)
  if (current && trainingPanels[0]) {
    var trainName = trainingPanels[0].querySelector('.training-skill-name');
    var trainLevel = trainingPanels[0].querySelector('.training-level');
    var trainTime = trainingPanels[0].querySelector('.training-time');
    var trainBar = trainingPanels[0].querySelector('.training-bar-fill');

    if (trainName) trainName.textContent = nameCache[current.skill_id] || 'Skill ID: ' + current.skill_id;
    if (trainTime) trainTime.textContent = formatTimeRemaining(current.finish_date);
    if (trainLevel) trainLevel.textContent = current.finished_level;
    if (trainBar && current.finish_date) {
      var total = new Date(current.finish_date) - new Date(current.start_date);
      var elapsed = new Date() - new Date(current.start_date);
      var pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
      trainBar["style"]["width"] = pct.toFixed(1) + "%";
      var pctEl = document.getElementById("training-pct");
      if (pctEl) pctEl.textContent = pct.toFixed(0) + "% complete";
      var finEl = document.getElementById("training-finish");
      if (finEl) finEl.textContent = "Finishes: " + new Date(current.finish_date).toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric"});
    } else if (current["training_start_sp"] !== undefined) {
      var spDone = current["training_start_sp"] - current.level_start_sp;
      var spTotal = current.level_end_sp - current.level_start_sp;
      var pct = spTotal > 0 ? Math.min(100, Math.max(0, (spDone / spTotal) * 100)) : 0;
      trainBar["style"]["width"] = pct.toFixed(1) + "%";
      var pctEl = document.getElementById("training-pct");
      if (pctEl) pctEl.textContent = pct.toFixed(0) + "% complete";
      var finEl = document.getElementById("training-finish");
      if (finEl) finEl.textContent = "Paused — resume to estimate finish date";
    }
  } else if (trainingPanels[0]) {
    var trainName = trainingPanels[0].querySelector('.training-skill-name');
    var trainLevel = trainingPanels[0].querySelector('.training-level');
    var trainTime = trainingPanels[0].querySelector('.training-time');
    var trainBar = trainingPanels[0].querySelector('.training-bar-fill');
    if (trainName) trainName.textContent = "No active training";
    if (trainLevel) trainLevel.textContent = "-";
    if (trainTime) trainTime.textContent = "-";
    if (trainBar) trainBar.style.width = "0%";
    var pctEl = document.getElementById("training-pct");
    if (pctEl) pctEl.textContent = "No active skill";
    var finEl = document.getElementById("training-finish");
    if (finEl) finEl.textContent = "Queue empty or completed";
  }

  // Skill queue list
  var queueList = document.getElementById("skill-queue-container");
  var queueTitle = document.getElementById("queue-title");
  if (queueList && queue.length === 0) {
    if (queueTitle) queueTitle.textContent = "Skill Queue — 0 skills";
    queueList.innerHTML = "<p style=\"font-size:13px;color:var(--t3);text-align:center;padding:24px 0;\">No active skills in queue</p>";
  } else if (queueList && queue.length > 0) {
    if (queueTitle) queueTitle.textContent = "Skill Queue — " + queue.length + " skills";
    var html = "";
    var levels = ["0", "I", "II", "III", "IV", "V"];
    queue.forEach(function(s, i) {
      var skillName = nameCache[s.skill_id] || "Skill ID: " + s.skill_id;
      var spDone = s["training_start_sp"] - s.level_start_sp;
      var spTotal = s.level_end_sp - s.level_start_sp;
      var pct = spTotal > 0 ? Math.min(100, Math.max(0, (spDone / spTotal) * 100)) : 0;
      var isActive = (i === 0);
      var skillRemaining = getSkillIndividualRemaining(s, isActive, isPaused);
      var queueRemaining = isPaused ? "Paused" : formatTimeRemaining(s.finish_date);
      html += "<div class=\"train-row" + (isActive ? " active" : "") + "\"><span class=\"train-name\">" + skillName + "</span><div class=\"train-prog\"><div class=\"train-prog-fill" + (isActive ? " active" : "") + "\" style=\"width:" + pct.toFixed(0) + "%\"></div></div><span class=\"train-lvl\"><span class=\"" + (isActive ? "training-level" : "queue-item-level") + "\">" + (levels[s.finished_level] || s.finished_level) + "</span></span><span class=\"train-skill-remaining" + (isActive ? " active" : "") + "\">" + skillRemaining + "</span><span class=\"train-time" + (isActive ? " active" : "") + "\">" + queueRemaining + "</span></div>";
    });
    queueList.innerHTML = html;
  }

  // Total SP
  if (data.skills) {
    var spEl = document.querySelector("#tab-training .panel:last-child .stat-val.sp");
    if (spEl) spEl.textContent = formatNumber(data["skills"]["total_sp"]);
  }
  // Attributes
  if (data.attributes) {
    var a = data.attributes;
    var el;
    el = document.getElementById("attr-perception"); if (el) el.textContent = a.perception || "—";
    el = document.getElementById("attr-memory"); if (el) el.textContent = a.memory || "—";
    el = document.getElementById("attr-willpower"); if (el) el.textContent = a.willpower || "—";
    el = document.getElementById("attr-intelligence"); if (el) el.textContent = a.intelligence || "—";
    el = document.getElementById("attr-charisma"); if (el) el.textContent = a.charisma || "—";
    el = document.getElementById("attr-remaps"); if (el) el.textContent = a.bonus_remaps !== undefined ? a.bonus_remaps : "—";
    el = document.getElementById("attr-lastremap"); if (el && a.last_remap_date) { el.textContent = new Date(a.last_remap_date).toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric"}); } else if (el) { el.textContent = "—"; }
  }
  // Training Stats
  if (data.skills) {
    var ts;
    ts = document.getElementById("ts-totalsp"); if (ts) ts.textContent = formatNumber(data["skills"]["total_sp"]);
    ts = document.getElementById("ts-unalloc"); if (ts) ts.textContent = formatNumber(data["skills"]["unallocated_sp"]);
    var skillsArr = data["skills"]["skills"] || [];
    ts = document.getElementById("ts-trained"); if (ts) ts.textContent = skillsArr.filter(function(s) { return s.trained_skill_level > 0; }).length;
    ts = document.getElementById("ts-atfive"); if (ts) ts.textContent = skillsArr.filter(function(s) { return s.trained_skill_level === 5; }).length;
  }
  if (data.skillqueue) {
    var ts = document.getElementById("ts-queuelen"); if (ts) ts.textContent = data.skillqueue.length + " skills";
  }
  // SP Breakdown by group
  var spContainer = document.getElementById("sp-breakdown-container");
  if (spContainer && data.skill_groups) {
    var sorted = Object.entries(data.skill_groups).sort(function(a,b) { return b[1] - a[1]; });
    var html = "";
    sorted.forEach(function(g) {
      html += "<div class=\"sp-cat\"><span class=\"sp-cat-name\">" + g[0] + "</span><span class=\"stat-val\">" + formatNumber(g[1]) + "</span></div>";
    });
    spContainer.innerHTML = html;
  } else if (spContainer) {
    spContainer.innerHTML = "<p style=\"font-size:13px;color:var(--t3);text-align:center;padding:16px 0;\">Skill breakdown unavailable</p>";
  }
}
// Populate Finance tab
function formatSignedISK(amount) {
  var n = Number(amount || 0);
  var sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return sign + formatISK(Math.abs(n));
}

function setFinanceValue(el, amount, suffix) {
  if (!el) return;
  var n = Number(amount || 0);
  el.textContent = formatSignedISK(n) + (suffix || "");
  el.style.color = n > 0 ? "var(--g)" : n < 0 ? "var(--r)" : "var(--t2)";
}

function getStartOfToday() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getStartOfWeek() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  var day = d.getDay(); // Sun=0
  var diff = day === 0 ? 6 : day - 1; // Monday start
  d.setDate(d.getDate() - diff);
  return d;
}

function getStartOfMonth() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

function sumWalletJournalSince(journal, startDate) {
  if (!Array.isArray(journal)) return null;

  var total = 0;
  var found = false;
  journal.forEach(function(row) {
    if (!row || row.amount === null || row.amount === undefined || !row.date) return;
    var date = new Date(row.date);
    if (isNaN(date.getTime())) return;

    if (date >= startDate) {
      total += Number(row.amount || 0);
      found = true;
    }
  });

  return found ? total : 0;
}

function getWalletJournalBreakdownSince(journal, startDate) {
  var result = { income: 0, outgoing: 0, net: 0, found: false };

  if (!Array.isArray(journal)) return result;

  journal.forEach(function(row) {
    if (!row || row.amount === null || row.amount === undefined || !row.date) return;
    var date = new Date(row.date);
    if (isNaN(date.getTime())) return;

    if (date >= startDate) {
      var amount = Number(row.amount || 0);
      result.net += amount;
      if (amount > 0) result.income += amount;
      if (amount < 0) result.outgoing += Math.abs(amount);
      result.found = true;
    }
  });

  return result;
}
















function updateTodayPnlTile(journal) {
  var pnlNetEl = document.getElementById("finance-pnl-today-net");
  var pnlIncomeEl = document.getElementById("finance-pnl-today-income");
  var pnlOutgoingEl = document.getElementById("finance-pnl-today-outgoing");
  var pnlLabelEl = document.getElementById("finance-pnl-today-label");

  var todayBreakdown = getWalletJournalBreakdownSince(journal, getStartOfToday());

  // If the API returned a journal array but there were no entries today, show 0 ISK,
  // not Tracking. Tracking should only mean the journal endpoint failed or was unavailable.
  if (todayBreakdown) {
    if (pnlNetEl) {
      pnlNetEl.textContent = formatSignedISK(todayBreakdown.net);
      pnlNetEl.style.color = todayBreakdown.net > 0 ? "var(--g)" : todayBreakdown.net < 0 ? "var(--r)" : "var(--t2)";
    }

    if (pnlLabelEl) {
      pnlLabelEl.textContent = todayBreakdown.net > 0 ? "Net profit today" : todayBreakdown.net < 0 ? "Net loss today" : "Net change today";
    }

    if (pnlIncomeEl) {
      pnlIncomeEl.textContent = "+" + formatISK(todayBreakdown.income);
      pnlIncomeEl.style.color = todayBreakdown.income > 0 ? "var(--g)" : "var(--t2)";
    }

    if (pnlOutgoingEl) {
      pnlOutgoingEl.textContent = "-" + formatISK(todayBreakdown.outgoing);
      pnlOutgoingEl.style.color = todayBreakdown.outgoing > 0 ? "var(--r)" : "var(--t2)";
    }

    return;
  }

  if (pnlNetEl) {
    pnlNetEl.textContent = "Tracking...";
    pnlNetEl.style.color = "var(--t3)";
  }
  if (pnlLabelEl) pnlLabelEl.textContent = "Net change today";
  if (pnlIncomeEl) {
    pnlIncomeEl.textContent = "Tracking...";
    pnlIncomeEl.style.color = "var(--t3)";
  }
  if (pnlOutgoingEl) {
    pnlOutgoingEl.textContent = "Tracking...";
    pnlOutgoingEl.style.color = "var(--t3)";
  }
}


function getLastNDaysKeys(daysBack) {
  var keys = [];
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  for (var i = daysBack - 1; i >= 0; i--) {
    var d = new Date(today.getTime() - i * 86400000);
    keys.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
  }

  return keys;
}

function getWalletDailyBuckets(journal, daysBack) {
  var keys = getLastNDaysKeys(daysBack);
  var buckets = {};

  keys.forEach(function(key) {
    buckets[key] = { income: 0, expenses: 0, net: 0 };
  });

  journal = Array.isArray(journal) ? journal : [];

  var earliestKey = keys.length ? keys[0] : null;
  var latestKey = keys.length ? keys[keys.length - 1] : null;

  journal.forEach(function(row) {
    if (!row || row.amount === null || row.amount === undefined || !row.date) return;

    var date = new Date(row.date);
    if (isNaN(date.getTime())) return;

    var key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    if (!buckets[key]) return;

    var amount = Number(row.amount || 0);
    buckets[key].net += amount;

    if (amount > 0) buckets[key].income += amount;
    if (amount < 0) buckets[key].expenses += Math.abs(amount);
  });

  return { keys: keys, buckets: buckets };
}

function calculateDailyAverages30(journal) {
  var data = getWalletDailyBuckets(journal, 30);
  var keys = data.keys;
  var buckets = data.buckets;

  var totalIncome = 0;
  var totalExpenses = 0;
  var totalNet = 0;
  var bestDay = null;
  var worstDay = null;

  keys.forEach(function(key) {
    var day = buckets[key] || { income: 0, expenses: 0, net: 0 };

    totalIncome += day.income;
    totalExpenses += day.expenses;
    totalNet += day.net;

    if (bestDay === null || day.net > bestDay) bestDay = day.net;
    if (worstDay === null || day.net < worstDay) worstDay = day.net;
  });

  return {
    avgIncome: totalIncome / 30,
    avgExpenses: totalExpenses / 30,
    avgProfit: totalNet / 30,
    bestDay: bestDay === null ? 0 : bestDay,
    worstDay: worstDay === null ? 0 : worstDay
  };
}

function updateDailyAveragesTile(journal) {
  journal = Array.isArray(journal) ? journal : [];

  var stats = calculateDailyAverages30(journal);

  var incomeEl = document.getElementById("finance-avg-daily-income");
  var expenseEl = document.getElementById("finance-avg-daily-expenses");
  var profitEl = document.getElementById("finance-avg-daily-profit");
  var bestEl = document.getElementById("finance-avg-best-day");
  var worstEl = document.getElementById("finance-avg-worst-day");

  if (incomeEl) {
    incomeEl.textContent = "+" + formatISK(stats.avgIncome);
    incomeEl.style.color = stats.avgIncome > 0 ? "var(--g)" : "var(--t2)";
  }

  if (expenseEl) {
    expenseEl.textContent = "-" + formatISK(stats.avgExpenses);
    expenseEl.style.color = stats.avgExpenses > 0 ? "var(--r)" : "var(--t2)";
  }

  setFinanceValue(profitEl, stats.avgProfit, "");
  setFinanceValue(bestEl, stats.bestDay, "");
  setFinanceValue(worstEl, stats.worstDay, "");
}


function walletPointSvg(x, y, row) {
  var dateText = formatAssetChartDate(row.created_at).replace(/"/g, "&quot;");
  var value = Number(row.balance || 0);
  var dataAttrs = ' data-value="' + value + '" data-date="' + dateText + '"';

  return '<g>' +
    '<circle class="asset-chart-hit" cx="' + x + '" cy="' + y + '" r="16" fill="transparent" stroke="transparent" pointer-events="all" onmousemove="showWalletSvgTooltip(this)" onmouseleave="hideWalletSvgTooltip()"' + dataAttrs + '></circle>' +
    '<circle class="asset-chart-point" cx="' + x + '" cy="' + y + '" r="6" fill="var(--acc)" stroke="var(--bg)" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="all" style="cursor:pointer;" onmousemove="showWalletSvgTooltip(this)" onmouseleave="hideWalletSvgTooltip()"' + dataAttrs + '></circle>' +
    '</g>';
}

function showWalletSvgTooltip(target) {
  var svg = document.getElementById("wallet-balance-svg");
  if (!svg || !target) return;

  var value = Number(target.getAttribute("data-value") || 0);
  var dateText = target.getAttribute("data-date") || "";
  var valueText = formatISK(value);

  var cx = parseFloat(target.getAttribute("cx") || "0");
  var cy = parseFloat(target.getAttribute("cy") || "0");

  var viewBox = svg.getAttribute("viewBox") || "0 0 600 135";
  var parts = viewBox.split(/\s+/).map(Number);
  var chartWidth = parts[2] || 600;
  var chartHeight = parts[3] || 135;

  var tooltip = document.getElementById("wallet-balance-svg-tooltip");
  if (!tooltip) {
    tooltip = document.createElementNS("http://www.w3.org/2000/svg", "g");
    tooltip.setAttribute("id", "wallet-balance-svg-tooltip");
    tooltip.setAttribute("pointer-events", "none");
    svg.appendChild(tooltip);
  }

  var boxWidth = Math.max(132, Math.max(valueText.length * 8, dateText.length * 6) + 26);
  var boxHeight = 44;
  var x = cx + 14;
  var y = cy - boxHeight - 12;

  if (x + boxWidth > chartWidth - 8) x = cx - boxWidth - 14;
  if (x < 8) x = 8;
  if (y < 8) y = cy + 16;
  if (y + boxHeight > chartHeight - 8) y = chartHeight - boxHeight - 8;

  tooltip.innerHTML =
    '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + boxWidth.toFixed(1) + '" height="' + boxHeight + '" rx="10" fill="#0a0e17" fill-opacity="0.98" stroke="#00b4d8" stroke-opacity="0.38"></rect>' +
    '<text x="' + (x + 12).toFixed(1) + '" y="' + (y + 18).toFixed(1) + '" fill="#00b4d8" style="font-family:JetBrains Mono, monospace;font-size:13px;font-weight:700;">' + svgEscapeText(valueText) + '</text>' +
    '<text x="' + (x + 12).toFixed(1) + '" y="' + (y + 34).toFixed(1) + '" fill="#555d6e" style="font-family:Inter, sans-serif;font-size:10px;font-weight:600;letter-spacing:0.7px;text-transform:uppercase;">' + svgEscapeText(dateText) + '</text>';

  tooltip.style.display = "block";
}

function hideWalletSvgTooltip() {
  var tooltip = document.getElementById("wallet-balance-svg-tooltip");
  if (tooltip) tooltip.style.display = "none";
}


function setWalletBalanceRange(days, btn) {
  selectedWalletBalanceRange = days;

  document.querySelectorAll(".wallet-range-btn").forEach(function(b) {
    b.classList.remove("active");
    b.style.background = "transparent";
    b.style.color = "var(--t3)";
  });

  if (btn) {
    btn.classList.add("active");
    btn.style.background = "var(--adim)";
    btn.style.color = "var(--acc)";
  }

  renderWalletBalanceChart(window.lastWalletAmountForChart, window.lastWalletSummaryForChart, days);
}

function renderWalletBalanceChart(currentWallet, summary, days) {
  days = days || selectedWalletBalanceRange || 7;
  window.lastWalletAmountForChart = currentWallet;
  window.lastWalletSummaryForChart = summary || null;
  var svgLine = document.getElementById("wallet-balance-line");
  var pointsGroup = document.getElementById("wallet-balance-points");
  var currentEl = document.getElementById("wallet-chart-current");
  var changeEl = document.getElementById("wallet-chart-change");
  var changeLabel = document.getElementById("wallet-chart-change-label");
  var rangeStartLabel = document.getElementById("wallet-chart-range-start");
  if (rangeStartLabel) rangeStartLabel.textContent = days + " days ago";

  if (!svgLine || !pointsGroup) return;

  var svg = svgLine.ownerSVGElement;
  var chartWidth = 600;
  var chartHeight = 135;

  if (svg) {
    var rect = svg.getBoundingClientRect();
    chartWidth = rect.width && rect.width > 0 ? rect.width : 600;
    chartHeight = rect.height && rect.height > 0 ? rect.height : 135;
    svg.setAttribute("viewBox", "0 0 " + chartWidth + " " + chartHeight);
  }

  var history = (walletBalanceHistory || []).filter(function(row) {
    return row && row.created_at && row.balance !== null && row.balance !== undefined;
  }).sort(function(a, b) {
    return new Date(a.created_at) - new Date(b.created_at);
  });

  // First-load fallback: show the current wallet as a single point while the first snapshot is being saved/returned.
  if (history.length < 1 && currentWallet !== null && currentWallet !== undefined) {
    history = [{ balance: Number(currentWallet || 0), created_at: new Date().toISOString() }];
  }

  pointsGroup.innerHTML = "";
  svgLine.setAttribute("points", "");
  hideWalletSvgTooltip();

  if (history.length < 1) {
    if (currentEl) currentEl.textContent = "Unavailable";
    if (changeLabel) changeLabel.textContent = "Status";
    if (changeEl) {
      changeEl.textContent = "Building " + days + "-day history";
      changeEl.style.color = "";
    }
    pointsGroup.innerHTML = '<text x="' + (chartWidth / 2).toFixed(1) + '" y="' + (chartHeight / 2).toFixed(1) + '" text-anchor="middle" fill="var(--t2)" style="font-size:13px;font-family:Inter,sans-serif;">Wallet balance will appear after first snapshot</text>';
    return;
  }

  if (currentEl) currentEl.textContent = formatISK(history[history.length - 1].balance);

  function dateKey(d) {
    return d.toISOString().slice(0, 10);
  }

  var byDay = {};
  history.forEach(function(row) {
    var key = dateKey(new Date(row.created_at));
    if (!byDay[key] || new Date(row.created_at) > new Date(byDay[key].created_at)) {
      byDay[key] = row;
    }
  });

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var dailyRows = [];
  var firstKnown = history.length ? history[0] : null;
  var lastKnown = null;
  var realDayCount = 0;

  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(today.getTime() - i * 86400000);
    var key = dateKey(d);
    var source = byDay[key];

    if (source) {
      realDayCount += 1;
      lastKnown = source;
    } else if (!lastKnown) {
      for (var h = history.length - 1; h >= 0; h--) {
        if (dateKey(new Date(history[h].created_at)) <= key) {
          lastKnown = history[h];
          break;
        }
      }
      source = lastKnown || firstKnown;
    } else {
      source = lastKnown;
    }

    if (!source && firstKnown) source = firstKnown;

    if (source) {
      dailyRows.push({
        created_at: d.toISOString(),
        day_key: key,
        balance: Number(source.balance || 0),
        carried_forward: !byDay[key]
      });
    }
  }

  var hasFullHistory = realDayCount >= days;

  if (!hasFullHistory) {
    if (changeLabel) changeLabel.textContent = "Status";
    if (changeEl) {
      changeEl.textContent = "Building " + days + "-day history";
      changeEl.style.color = "";
    }
  } else {
    if (changeLabel) changeLabel.textContent = days + "d Change";
  }

  var leftPad = 18;
  var rightPad = 18;
  var topPad = 12;
  var bottomPad = 18;
  var usableWidth = chartWidth - leftPad - rightPad;
  var usableHeight = chartHeight - topPad - bottomPad;

  if (dailyRows.length === 1) {
    var singleX = (chartWidth / 2).toFixed(1);
    var singleY = (topPad + usableHeight / 2).toFixed(1);
    pointsGroup.innerHTML = walletPointSvg(singleX, singleY, dailyRows[0]);
    return;
  }

  var values = dailyRows.map(function(row) { return Number(row.balance || 0); });
  var minVal = Math.min.apply(null, values);
  var maxVal = Math.max.apply(null, values);

  if (minVal === maxVal) {
    minVal = minVal * 0.98;
    maxVal = maxVal * 1.02;
  }

  var points = dailyRows.map(function(row, i) {
    var x = leftPad + (i / (dailyRows.length - 1)) * usableWidth;
    var value = Number(row.balance || 0);
    var y = topPad + (1 - ((value - minVal) / (maxVal - minVal))) * usableHeight;
    return { x: x, y: y, row: row };
  });

  svgLine.setAttribute("points", points.map(function(p) {
    return p.x.toFixed(1) + "," + p.y.toFixed(1);
  }).join(" "));

  var circles = "";
  points.forEach(function(p) {
    circles += walletPointSvg(p.x.toFixed(1), p.y.toFixed(1), p.row);
  });
  pointsGroup.innerHTML = circles;

  if (hasFullHistory) {
    var first = dailyRows[0];
    var last = dailyRows[dailyRows.length - 1];
    var change = Number(last.balance || 0) - Number(first.balance || 0);

    if (changeEl) {
      changeEl.textContent = (change > 0 ? "+" : "") + formatISK(change);
      changeEl.style.color = change > 0 ? "var(--g)" : change < 0 ? "var(--r)" : "";
    }
  }
}

function populateFinance(data) {
  data = data || {};

  var walletAmount = data.wallet;
  var walletEls = document.querySelectorAll('#tab-finance .wallet-balance');
  walletEls.forEach(function(el) {
    el.textContent = walletAmount !== null && walletAmount !== undefined ? formatISK(walletAmount) : "Unavailable";
  });

  var journal = Array.isArray(data.wallet_journal) ? data.wallet_journal : [];

  var todayEl = document.getElementById("finance-wallet-today");
  var weekEl = document.getElementById("finance-wallet-week");
  var monthEl = document.getElementById("finance-wallet-month");

  // If the journal is empty, show 0 values instead of Tracking.
  // Tracking should not appear just because a character has no activity.
  setFinanceValue(todayEl, sumWalletJournalSince(journal, getStartOfToday()), " today");
  setFinanceValue(weekEl, sumWalletJournalSince(journal, getStartOfWeek()), "");
  setFinanceValue(monthEl, sumWalletJournalSince(journal, getStartOfMonth()), "");

  updateTodayPnlTile(journal);
  updateDailyAveragesTile(journal);

  var walletSummary = data.wallet_summary || null;
  walletBalanceHistory = walletSummary && Array.isArray(walletSummary.history) ? walletSummary.history : [];
  renderWalletBalanceChart(walletAmount, walletSummary, selectedWalletBalanceRange || 7);
}

// Populate Assets tab





var assetLocationsData = [];
var selectedAssetLocationId = null;

function renderAssetLocations(locations) {
  var container = document.getElementById("asset-locations-container");
  if (!container) return;

  locations = Array.isArray(locations) ? locations.slice(0, 20) : [];
  assetLocationsData = locations;

  if (locations.length === 0) {
    container.innerHTML = '<p style="font-size:13px;color:var(--t3);text-align:center;padding:18px 0;">No priced location data available yet</p>';
    renderAssetLocationDropdown([]);
    return;
  }

  var maxValue = Math.max.apply(null, locations.map(function(loc) { return Number(loc.value || 0); }));
  if (!maxValue || maxValue <= 0) maxValue = 1;

  var html = '';
  locations.forEach(function(loc) {
    var name = loc.name || ('Location ' + loc.location_id);
    var percent = Math.max(4, Math.min(100, (Number(loc.value || 0) / maxValue) * 100));

    html += '<div class="asset-location-row">';
    html += '<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:6px;">';
    html += '<span class="asset-location-name" style="font-size:13px;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</span>';
    html += '<span class="asset-location-value" style="font-family:var(--m);font-size:13px;color:var(--g);white-space:nowrap;">' + formatISK(loc.value || 0).replace(" ISK","") + '</span>';
    html += '</div>';
    html += '<div class="bar-bg" style="height:6px;background:var(--adim);border-radius:999px;overflow:hidden;margin-bottom:11px;">';
    html += '<div class="bar-fill" style="height:100%;width:' + percent.toFixed(1) + '%;background:var(--g);border-radius:999px;"></div>';
    html += '</div>';
    html += '</div>';
  });

  container.innerHTML = html;
  renderAssetLocationDropdown(locations);
}

function toggleAssetLocationDropdown(event) {
  if (event) event.stopPropagation();

  var dropdown = document.getElementById("asset-location-dropdown");
  if (!dropdown) return;

  dropdown.classList.toggle("open");
}

function closeAssetLocationDropdown() {
  var dropdown = document.getElementById("asset-location-dropdown");
  if (dropdown) dropdown.classList.remove("open");
}

function selectAssetLocation(locationId) {
  selectedAssetLocationId = String(locationId);
  closeAssetLocationDropdown();
  renderAssetLocationDropdown(assetLocationsData || []);
  renderSelectedAssetLocation();
}

function renderAssetLocationDropdown(locations) {
  var dropdown = document.getElementById("asset-location-dropdown");
  var button = document.getElementById("asset-location-dropdown-btn");
  var menu = document.getElementById("asset-location-dropdown-menu");
  if (!dropdown || !button || !menu) return;

  locations = Array.isArray(locations) ? locations : [];

  if (locations.length === 0) {
    button.textContent = "No locations found";
    menu.innerHTML = "";
    renderSelectedAssetLocation();
    return;
  }

  if (!selectedAssetLocationId || !locations.some(function(loc) { return String(loc.location_id) === String(selectedAssetLocationId); })) {
    selectedAssetLocationId = String(locations[0].location_id);
  }

  var selectedLoc = locations.find(function(loc) {
    return String(loc.location_id) === String(selectedAssetLocationId);
  });

  button.textContent = selectedLoc
    ? (selectedLoc.name + " — " + formatISK(selectedLoc.value || 0).replace(" ISK",""))
    : "Choose location";

  var html = "";
  locations.forEach(function(loc) {
    var active = String(loc.location_id) === String(selectedAssetLocationId) ? " active" : "";
    html += '<div class="asset-location-dropdown-option' + active + '" onclick="selectAssetLocation(\'' + String(loc.location_id).replace(/'/g, "\\'") + '\')">';
    html += '<span class="asset-location-dropdown-option-name">' + (loc.name || ("Location " + loc.location_id)) + '</span>';
    html += '<span class="asset-location-dropdown-option-value">' + formatISK(loc.value || 0).replace(" ISK","") + '</span>';
    html += '</div>';
  });

  menu.innerHTML = html;
  renderSelectedAssetLocation();
}

function renderSelectedAssetLocation() {
  var container = document.getElementById("asset-location-items-container");
  var title = document.getElementById("asset-station-view-title");
  if (!container) return;

  var loc = (assetLocationsData || []).find(function(item) {
    return String(item.location_id) === String(selectedAssetLocationId);
  });

  if (!loc) {
    if (title) title.textContent = "Asset Location Contents";
    container.innerHTML = '<p style="font-size:13px;color:var(--t3);text-align:center;padding:18px 0;">No location selected</p>';
    return;
  }

  if (title) title.textContent = loc.name;

  var items = Array.isArray(loc.items) ? loc.items : [];
  if (items.length === 0) {
    container.innerHTML = '<p style="font-size:13px;color:var(--t3);text-align:center;padding:18px 0;">No priced items found in this location</p>';
    return;
  }

  var html = '';
  items.forEach(function(item) {
    var name = item.name || ('Type ID ' + item.type_id);
    html += '<div class="asset-line">';
    html += '<span class="asset-line-name">' + name + '</span>';
    html += '<span class="asset-line-qty">' + formatNumber(item.quantity || 1) + '</span>';
    html += '<span class="asset-line-val">' + formatISK(item.value || 0).replace(" ISK","") + '</span>';
    html += '</div>';
  });

  container.innerHTML = html;
}

document.addEventListener("click", function(event) {
  var dropdown = document.getElementById("asset-location-dropdown");
  if (dropdown && !dropdown.contains(event.target)) closeAssetLocationDropdown();
});


function populateAssets(data) {
  if (!data.assets) return;

  var assets = data.assets || [];
  var summary = data.asset_summary || null;

  var el;
  if (summary) {
    renderAssetLocations(summary.asset_locations || []);
    assetValueHistory = summary.history || [];
    setTimeout(function() { renderAssetValueChart(selectedAssetValueRange || 7); }, 0);

    el = document.getElementById("assets-total-value");
    if (el) el.textContent = summary.total_asset_value !== null && summary.total_asset_value !== undefined
      ? formatISK(summary.total_asset_value)
      : "Calculating...";

    el = document.getElementById("assets-stations");
    if (el) el.textContent = formatNumber(summary.stations || 0);

    el = document.getElementById("assets-ships");
    if (el) el.textContent = formatNumber(summary.ships || 0);

    el = document.getElementById("assets-change-7d");
    if (el) {
      el.textContent = formatAssetChangeOrCountdown(summary.change_7d, summary.days_until_7d_change, 7);
      el.style.color = summary.change_7d > 0 ? "var(--g)" : summary.change_7d < 0 ? "var(--r)" : "";
    }

    el = document.getElementById("assets-change-14d");
    if (el) {
      el.textContent = formatAssetChangeOrCountdown(summary.change_14d, summary.days_until_14d_change, 14);
      el.style.color = summary.change_14d > 0 ? "var(--g)" : summary.change_14d < 0 ? "var(--r)" : "";
    }

    el = document.getElementById("assets-change-30d");
    if (el) {
      el.textContent = formatAssetChangeOrCountdown(summary.change_30d, summary.days_until_30d_change, 30);
      el.style.color = summary.change_30d > 0 ? "var(--g)" : summary.change_30d < 0 ? "var(--r)" : "";
    }
  } else {
    renderAssetLocations([]);
    var itemCount = 0;
    var uniqueTypes = {};
    var locations = {};
    assets.forEach(function(a) {
      itemCount += parseInt(a.quantity || 1, 10);
      if (a.type_id) uniqueTypes[a.type_id] = true;
      if (a.location_id && a.location_type !== "item") locations[a.location_id] = true;
    });

    el = document.getElementById("assets-total-value"); if (el) el.textContent = "Calculating...";
    el = document.getElementById("assets-stations"); if (el) el.textContent = Object.keys(locations).length;
    el = document.getElementById("assets-ships"); if (el) el.textContent = "—";
    el = document.getElementById("assets-change-7d"); if (el) el.textContent = "—";
    el = document.getElementById("assets-change-14d"); if (el) el.textContent = "—";
    el = document.getElementById("assets-change-30d"); if (el) el.textContent = "—";
  }

  // Existing asset list preview, if that list exists elsewhere on the tab.
  var assetList = document.querySelector('#tab-assets .asset-list');
  if (assetList) {
    var html = '';
    assets.slice(0, 20).forEach(function(a) {
      var typeName = nameCache[a.type_id] || 'Type ID: ' + a.type_id;
      html += '<div class="asset-row">';
      html += '<span>' + typeName + '</span>';
      html += '<span>x' + (a.quantity || 1) + '</span>';
      html += '</div>';
    });
    assetList.innerHTML = html;
  }
}

// Populate Market tab
function populateMarket(data) {
  if (!data.orders) return;
  var sellOrders = data.orders.filter(function(o) { return !o.is_buy_order; });
  var buyOrders = data.orders.filter(function(o) { return o.is_buy_order; });
  // Market Overview
  var el;
  el = document.getElementById("mkt-buy-count"); if (el) el.textContent = buyOrders.length;
  el = document.getElementById("mkt-sell-count"); if (el) el.textContent = sellOrders.length;
  var buyISK = 0; buyOrders.forEach(function(o) { buyISK += o.price * o.volume_remain; });
  var sellISK = 0; sellOrders.forEach(function(o) { sellISK += o.price * o.volume_remain; });
  var escrowTotal = 0; buyOrders.forEach(function(o) { if (o.escrow) escrowTotal += o.escrow; });
  el = document.getElementById("mkt-buy-isk"); if (el) el.textContent = formatISK(buyISK);
  el = document.getElementById("mkt-sell-isk"); if (el) el.textContent = formatISK(sellISK);
  el = document.getElementById("mkt-escrow"); if (el) el.textContent = formatISK(escrowTotal);
  // Sell Orders
  var sellContainer = document.getElementById("sell-orders-container");
  var sellTitle = document.getElementById("sell-orders-title");
  if (sellContainer) {
    if (sellTitle) sellTitle.textContent = "My Sell Orders — " + sellOrders.length + " Active";
    if (sellOrders.length > 0) {
      var html = "";
      sellOrders.forEach(function(o) {
        var typeName = nameCache[o.type_id] || "Type ID: " + o.type_id;
        var total = o.price * o.volume_remain;
        html += "<div class=\"order-row\"><span class=\"order-name\">" + typeName + "</span><span class=\"order-qty\">" + o.volume_remain + "</span><span class=\"order-price\">" + formatISK(o.price) + "</span><span class=\"order-total\">" + formatISK(total) + "</span><span class=\"order-status active\">Active</span></div>";
      });
      sellContainer.innerHTML = html;
    } else {
      sellContainer.innerHTML = "<p style=\"font-size:13px;color:var(--t3);text-align:center;padding:24px 0;\">No active sell orders</p>";
    }
  }
  // Buy Orders
  var buyContainer = document.getElementById("buy-orders-container");
  var buyTitle = document.getElementById("buy-orders-title");
  if (buyContainer) {
    if (buyTitle) buyTitle.textContent = "My Buy Orders — " + buyOrders.length + " Active";
    if (buyOrders.length > 0) {
      var html = "";
      buyOrders.forEach(function(o) {
        var typeName = nameCache[o.type_id] || "Type ID: " + o.type_id;
        var total = o.price * o.volume_remain;
        html += "<div class=\"order-row\"><span class=\"order-name\">" + typeName + "</span><span class=\"order-qty\">" + o.volume_remain + "</span><span class=\"order-price\">" + formatISK(o.price) + "</span><span class=\"order-total\">" + formatISK(total) + "</span><span class=\"order-status active\">Active</span></div>";
      });
      buyContainer.innerHTML = html;
    } else {
      buyContainer.innerHTML = "<p style=\"font-size:13px;color:var(--t3);padding:8px 0;\">No active buy orders</p>";
    }
  }
  // Trading Stats from wallet journal
  if (data.wallet_journal) {
    var bought = 0; var sold = 0; var broker = 0; var tax = 0; var txCount = 0;
    data.wallet_journal.forEach(function(j) {
      if (j.ref_type === "market_escrow") bought += Math.abs(j.amount);
      if (j.ref_type === "market_transaction") { if (j.amount > 0) sold += j.amount; txCount++; }
      if (j.ref_type === "brokers_fee") broker += Math.abs(j.amount);
      if (j.ref_type === "transaction_tax") tax += Math.abs(j.amount);
    });
    var el;
    el = document.getElementById("ts-bought"); if (el) el.textContent = "-" + formatISK(bought);
    el = document.getElementById("ts-sold"); if (el) el.textContent = "+" + formatISK(sold);
    el = document.getElementById("ts-broker"); if (el) el.textContent = "-" + formatISK(broker);
    el = document.getElementById("ts-tax"); if (el) el.textContent = "-" + formatISK(tax);
    el = document.getElementById("ts-txcount"); if (el) el.textContent = txCount;
  }
  // Recent Trade History
  var tradeContainer = document.getElementById("trade-history-container");
  if (tradeContainer && data.wallet_transactions) {
    var trades = data.wallet_transactions.slice(0, 15);
    if (trades.length > 0) {
      var tradeIds = trades.map(function(t) { return t.type_id; });
      resolveNames(tradeIds).then(function() {
        var html = "";
        trades.forEach(function(t) {
          var isBuy = t.is_buy;
          var typeName = nameCache[t.type_id] || "Type ID: " + t.type_id;
          var total = t.quantity * t.unit_price;
          var date = new Date(t.date);
          var now = new Date();
          var diff = Math.floor((now - date) / 86400000);
          var when = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : diff + "d ago";
          html += "<div class=\"trade-row\"><span class=\"trade-type " + (isBuy ? "buy" : "sell") + "\">" + (isBuy ? "Bought" : "Sold") + "</span><span class=\"trade-item\">" + typeName + "</span><span class=\"trade-qty\">" + t.quantity + "</span><span class=\"trade-price\">" + formatISK(total) + "</span><span class=\"trade-when\">" + when + "</span></div>";
        });
        tradeContainer.innerHTML = html;
      });
    }
  }
}
// Fetch Jita prices for popular items
async function loadJitaPrices() {
  var items = [
    { id: 44992, name: "PLEX" },
    { id: 40520, name: "Large Skill Injector" },
    { id: 45635, name: "Small Skill Injector" },
    { id: 33681, name: "Gecko" },
    { id: 34, name: "Tritanium" }
  ];
  var container = document.getElementById("jita-prices-container");
  if (!container) return;
  try {
    var ids = items.map(function(i) { return i.id; }).join(",");
    var resp = await fetch("https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=" + ids);
    if (!resp.ok) throw "Failed";
    var data = await resp.json();
    var html = "";
    items.forEach(function(item) {
      var d = data[item.id];
      if (!d) return;
      var buy = parseFloat(d.buy.max);
      var sell = parseFloat(d.sell.min);
      var spread = sell > 0 ? (((sell - buy) / sell) * 100).toFixed(1) : "0.0";
      html += "<div class=\"mkt-watch\"><span class=\"mkt-watch-name\">" + item.name + "</span><span class=\"mkt-watch-buy\">" + formatISK(buy).replace(" ISK","") + "</span><span class=\"mkt-watch-sell\">" + formatISK(sell).replace(" ISK","") + "</span><span class=\"mkt-watch-spread\">" + spread + "%</span><span></span></div>";
    });
    if (html) { container.innerHTML = html; } else { throw "No data"; }
  } catch(e) {
    container.innerHTML = "<p style=\"font-size:13px;color:var(--t3);text-align:center;\">Failed to load prices</p>";
  }
}
function populateFleet(data) {
  if (!data.ship) return;
  var fleetPanels = document.querySelectorAll("#tab-fleet .panel");
  if (fleetPanels[0]) {
    var shipTypeName = nameCache[data.ship.ship_type_id] || "Unknown Ship";
    var locationName = data.location ? (nameCache[data["location"]["solar_system_id"]] || "Unknown") : "Unknown";
    var nameEl = fleetPanels[0].querySelector("div[style*=\"font-size:20px\"]");
    if (nameEl) nameEl.textContent = shipTypeName;
    var classEl = fleetPanels[0].querySelector("div[style*=\"font-size:12px\"]");
    if (classEl) classEl.textContent = data.ship_group || "";
    var statVals = fleetPanels[0].querySelectorAll(".stat-val");
    if (statVals[0]) statVals[0].textContent = locationName;
  }
  var container = document.getElementById("fleet-members-container");
  var title = document.getElementById("fleet-panel-title");
  if (!container) return;
  if (data.fleet && data.fleet.length > 0) {
    if (title) title.textContent = "Fleet Members — " + data.fleet.length + " pilots";
    var idsToResolve = [];
    data.fleet.forEach(function(m) { idsToResolve.push(m.character_id); idsToResolve.push(m.ship_type_id); idsToResolve.push(m["solar_system_id"]); });
    resolveNames(idsToResolve).then(function() {
      var html = "<div style=\"display:grid;grid-template-columns:1fr 120px 140px 80px;gap:0;font-size:10px;color:var(--heading);text-transform:uppercase;letter-spacing:0.8px;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:4px;\"><span>Pilot</span><span>Ship</span><span>System</span><span style=\"text-align:right\">Role</span></div>";
      data.fleet.forEach(function(m) {
        var pilotName = nameCache[m.character_id] || "Unknown";
        var shipName = nameCache[m.ship_type_id] || "Unknown";
        var sysName = nameCache[m["solar_system_id"]] || "Unknown";
        var role = m.role || "fleet_member";
        role = role.replace("fleet_commander","FC").replace("wing_commander","WC").replace("squad_commander","SC").replace("squad_member","Member");
        html += "<div class=\"fleet-row\"><span class=\"fleet-ship\">" + pilotName + "</span><span class=\"fleet-loc\">" + shipName + "</span><span class=\"fleet-loc\">" + sysName + "</span><span class=\"fleet-status docked\">" + role + "</span></div>";
      });
      container.innerHTML = html;
    });
      // Fleet Composition
      var compContainer = document.getElementById("fleet-comp-container");
      var compTitle = document.getElementById("fleet-comp-title");
      if (compContainer) {
        var groups = {};
        data.fleet.forEach(function(m) {
          var shipName = nameCache[m.ship_type_id] || "Unknown";
          groups[shipName] = (groups[shipName] || 0) + 1;
        });
        var sorted = Object.entries(groups).sort(function(a,b) { return b[1] - a[1]; });
        if (compTitle) compTitle.textContent = "Fleet Composition — " + sorted.length + " ship types";
        var compHtml = "";
        sorted.forEach(function(s) {
          var pct = Math.round((s[1] / data.fleet.length) * 100);
          compHtml += "<div style=\"display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);\"><span style=\"font-size:13px;\">" + s[0] + "</span><div style=\"display:flex;align-items:center;gap:8px;\"><div style=\"width:60px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;\"><div style=\"width:" + pct + "%;height:100%;background:var(--a);border-radius:3px;\"></div></div><span style=\"font-size:12px;color:var(--t3);min-width:30px;text-align:right;\">" + s[1] + "</span></div></div>";
        });
        compContainer.innerHTML = compHtml;
      }
  } else {
    if (title) title.textContent = "Fleet Members";
    container.innerHTML = "<p style=\"font-size:13px;color:var(--t3);padding:16px 0;text-align:center;\">Not currently in a fleet<br><span style=\"font-size:11px;color:var(--t3);opacity:0.6;\">Join a fleet in-game and ensure fleet auth is enabled to see members here</span></p>";
    var compContainer = document.getElementById("fleet-comp-container");
    var compTitle = document.getElementById("fleet-comp-title");
    if (compTitle) compTitle.textContent = "Fleet Composition";
    if (compContainer) compContainer.innerHTML = "<p style=\"font-size:13px;color:var(--t3);text-align:center;\">No fleet data</p>";
  }
}

// Override demo functions
function randomise() { }
function loadCharacter() { }
function switchChar() { }

// Initialize on page load
window.addEventListener('DOMContentLoaded', initDashboard);
