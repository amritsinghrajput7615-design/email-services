// ─── Dashboard App.js ────────────────────────────────────────
// Shopify Email Automation — Admin Dashboard

const API_BASE = '/api/admin';

// ─── State ────────────────────────────────────────────────────
let currentTab = 'email-logs';
let emailLogsPage = 1;
let abandonedCartsPage = 1;
let webhookLogsPage = 1;
let emailTypeFilter = 'all';
let statusFilter = 'all';
let autoRefreshInterval = null;

// ─── DOM Ready ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initTabs();
  initFilters();
  fetchStats();
  fetchEmailLogs();
  startAutoRefresh();
});

// ─── Clock ────────────────────────────────────────────────────
function initClock() {
  const clockEl = document.getElementById('live-clock');
  if (!clockEl) return;
  function update() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  update();
  setInterval(update, 1000);
}

// ─── Auto-Refresh ──────────────────────────────────────────────
function startAutoRefresh() {
  autoRefreshInterval = setInterval(() => {
    fetchStats();
    if (currentTab === 'email-logs') fetchEmailLogs(emailLogsPage);
    else if (currentTab === 'abandoned-carts') fetchAbandonedCarts(abandonedCartsPage);
    else if (currentTab === 'webhook-logs') fetchWebhookLogs(webhookLogsPage);
  }, 30000);
}

// ─── Tabs ─────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  currentTab = tab;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');

  if (tab === 'email-logs') fetchEmailLogs(1);
  else if (tab === 'abandoned-carts') fetchAbandonedCarts(1);
  else if (tab === 'webhook-logs') fetchWebhookLogs(1);
}

// ─── Filters ──────────────────────────────────────────────────
function initFilters() {
  document.getElementById('filter-type')?.addEventListener('change', e => {
    emailTypeFilter = e.target.value;
    emailLogsPage = 1;
    fetchEmailLogs(1);
  });
  document.getElementById('filter-status')?.addEventListener('change', e => {
    statusFilter = e.target.value;
    emailLogsPage = 1;
    fetchEmailLogs(1);
  });
}

// ─── Stats ────────────────────────────────────────────────────
async function fetchStats() {
  try {
    const data = await apiGet('/stats');
    animateCount('stat-sent', data.totalSent || 0);
    animateCount('stat-failed', data.totalFailed || 0);
    animateCount('stat-abandoned', data.activeAbandoned || 0);
    animateCount('stat-recovered', data.recovered || 0);
  } catch (err) {
    console.error('Stats fetch failed:', err);
  }
}

function animateCount(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const diff = target - start;
  if (diff === 0) return;
  const duration = 600;
  const steps = 20;
  let step = 0;
  const interval = setInterval(() => {
    step++;
    el.textContent = Math.round(start + (diff * step) / steps);
    if (step >= steps) {
      el.textContent = target;
      clearInterval(interval);
    }
  }, duration / steps);
}

// ─── Email Logs ───────────────────────────────────────────────
async function fetchEmailLogs(page = 1) {
  emailLogsPage = page;
  const tbody = document.getElementById('email-logs-tbody');
  const paginationEl = document.getElementById('email-logs-pagination');
  if (!tbody) return;

  showSkeleton(tbody, 6);

  try {
    const params = new URLSearchParams({
      page,
      limit: 20,
      type: emailTypeFilter,
      status: statusFilter,
    });
    const data = await apiGet(`/email-logs?${params}`);

    tbody.innerHTML = '';
    if (!data.data || data.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><div class="empty-icon">📭</div><p>No email logs found</p></td></tr>`;
      return;
    }

    data.data.forEach(log => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${emailTypeBadge(log.emailType)}</td>
        <td class="email-cell" title="${log.recipientEmail}">${log.recipientEmail}</td>
        <td>${statusBadge(log.status)}</td>
        <td class="time-cell">${formatDate(log.sentAt || log.createdAt)}</td>
        <td style="text-align:center;">${log.attempts}</td>
        <td>
          <button class="btn-resend" onclick="resendEmail('${log.id}')" title="Resend this email">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            Resend
          </button>
        </td>
      `;
      tbody.appendChild(row);
    });

    renderPagination(paginationEl, page, data.totalPages, (p) => fetchEmailLogs(p));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error-state">Failed to load email logs: ${err.message}</td></tr>`;
  }
}

// ─── Abandoned Carts ──────────────────────────────────────────
async function fetchAbandonedCarts(page = 1) {
  abandonedCartsPage = page;
  const tbody = document.getElementById('carts-tbody');
  const paginationEl = document.getElementById('carts-pagination');
  if (!tbody) return;

  showSkeleton(tbody, 4);

  try {
    const data = await apiGet(`/abandoned-carts?page=${page}&limit=20`);

    tbody.innerHTML = '';
    if (!data.data || data.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><div class="empty-icon">🛒</div><p>No abandoned carts</p></td></tr>`;
      return;
    }

    data.data.forEach(cart => {
      const items = Array.isArray(cart.cartItems) ? cart.cartItems : [];
      const itemCount = items.length;
      const itemNames = items.slice(0, 2).map(i => i.name).join(', ') + (itemCount > 2 ? ` +${itemCount - 2} more` : '');
      const timeSince = timeAgo(cart.updatedAt);

      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="email-cell" title="${cart.customerEmail}">${cart.customerEmail}</td>
        <td><span title="${itemNames}">${itemCount} item${itemCount !== 1 ? 's' : ''}</span></td>
        <td class="amount-cell">${cart.currency} ${cart.totalPrice}</td>
        <td>${cartStatusBadge(cart.status)}</td>
        <td class="time-cell">${timeSince}</td>
        <td class="time-cell">${formatDate(cart.createdAt)}</td>
      `;
      tbody.appendChild(row);
    });

    renderPagination(paginationEl, page, data.totalPages, (p) => fetchAbandonedCarts(p));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error-state">Failed to load carts: ${err.message}</td></tr>`;
  }
}

// ─── Webhook Logs ─────────────────────────────────────────────
async function fetchWebhookLogs(page = 1) {
  webhookLogsPage = page;
  const tbody = document.getElementById('webhook-tbody');
  const paginationEl = document.getElementById('webhook-pagination');
  if (!tbody) return;

  showSkeleton(tbody, 3);

  try {
    const data = await apiGet(`/webhook-logs?page=${page}&limit=20`);

    tbody.innerHTML = '';
    if (!data.data || data.data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><div class="empty-icon">📡</div><p>No webhook logs</p></td></tr>`;
      return;
    }

    data.data.forEach(log => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${sourceBadge(log.source)}</td>
        <td><code style="font-size:12px;background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;">${log.topic}</code></td>
        <td>${webhookStatusBadge(log.status)}</td>
        <td class="time-cell">${formatDate(log.createdAt)}</td>
      `;
      tbody.appendChild(row);
    });

    renderPagination(paginationEl, page, data.totalPages, (p) => fetchWebhookLogs(p));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="error-state">Failed to load webhooks: ${err.message}</td></tr>`;
  }
}

// ─── Resend Email ─────────────────────────────────────────────
async function resendEmail(logId) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const result = await apiPost(`/resend-email/${logId}`);
    showToast('Email resent successfully! ✅', 'success');
    fetchEmailLogs(emailLogsPage);
  } catch (err) {
    showToast(`Failed to resend: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
      Resend
    `;
  }
}

// ─── API Helpers ──────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Formatters ───────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return iso; }
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const EMAIL_TYPE_LABELS = {
  abandoned_cart_1: '🛒 Cart Reminder 1',
  abandoned_cart_2: '🛒 Cart Reminder 2',
  order_confirmation: '✅ Order Confirmed',
  order_shipped: '🚚 Shipped',
  out_for_delivery: '📦 Out for Delivery',
  delivered: '🎉 Delivered',
  refund_completed: '💸 Refund',
};

const EMAIL_TYPE_CLASSES = {
  abandoned_cart_1: 'badge-amber',
  abandoned_cart_2: 'badge-orange',
  order_confirmation: 'badge-blue',
  order_shipped: 'badge-purple',
  out_for_delivery: 'badge-indigo',
  delivered: 'badge-green',
  refund_completed: 'badge-gray',
};

function emailTypeBadge(type) {
  const label = EMAIL_TYPE_LABELS[type] || type;
  const cls = EMAIL_TYPE_CLASSES[type] || 'badge-gray';
  return `<span class="badge ${cls}">${label}</span>`;
}

function statusBadge(status) {
  const map = {
    sent: ['badge-green', '✓ Sent'],
    failed: ['badge-red', '✗ Failed'],
    retrying: ['badge-amber', '↻ Retrying'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function cartStatusBadge(status) {
  const map = {
    active: ['badge-amber', '⏳ Active'],
    abandoned: ['badge-orange', '⚠ Abandoned'],
    converted: ['badge-green', '✓ Converted'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function sourceBadge(source) {
  const map = {
    shopify: ['badge-green', '🛍 Shopify'],
    shiprocket: ['badge-blue', '🚀 Shiprocket'],
  };
  const [cls, label] = map[source] || ['badge-gray', source];
  return `<span class="badge ${cls}">${label}</span>`;
}

function webhookStatusBadge(status) {
  const map = {
    received: ['badge-blue', '📥 Received'],
    processed: ['badge-green', '✓ Processed'],
    error: ['badge-red', '✗ Error'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ─── Skeleton Loader ──────────────────────────────────────────
function showSkeleton(tbody, cols) {
  tbody.innerHTML = Array(5).fill(0).map(() => `
    <tr>${Array(cols).fill(0).map(() => `<td><div class="skeleton"></div></td>`).join('')}</tr>
  `).join('');
}

// ─── Pagination ───────────────────────────────────────────────
function renderPagination(container, currentPage, totalPages, onPageChange) {
  if (!container) return;
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const pages = [];
  // Always show first, last, current±2
  const show = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1, currentPage - 2, currentPage + 2].filter(p => p >= 1 && p <= totalPages));
  const sorted = [...show].sort((a, b) => a - b);

  let html = `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="(${onPageChange})(${currentPage - 1})">← Prev</button>`;

  let prev = null;
  sorted.forEach(p => {
    if (prev && p - prev > 1) html += `<span class="page-ellipsis">…</span>`;
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="(${onPageChange})(${p})">${p}</button>`;
    prev = p;
  });

  html += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="(${onPageChange})(${currentPage + 1})">Next →</button>`;
  html += `<span class="page-info">Page ${currentPage} of ${totalPages}</span>`;

  container.innerHTML = html;
}

// ─── Toast ────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${message}</span>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;font-size:18px;line-height:1;padding:0 0 0 12px;">×</button>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// Make resendEmail globally available (called from inline onclick)
window.resendEmail = resendEmail;
