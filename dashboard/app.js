let chart;
let currentStatsData = null;

// Navigation
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.dataset.target;
        document.getElementById(targetId).classList.add('active');

        if (targetId === 'logs') fetchGlobalLogs();
        if (targetId === 'users') fetchUsers();
    });
});

async function fetchStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();

        document.getElementById('stat-total-users').innerText = data.metrics.totalUsers;
        document.getElementById('stat-active-sessions').innerText = data.metrics.activeUsers;
        document.getElementById('stat-premium').innerText = data.metrics.premiumUsers;
        document.getElementById('stat-blocked').innerText = data.metrics.blockedUsers;
        document.getElementById('stat-rewards').innerText = data.metrics.totalCollections;

        // Порівнюємо дані, щоб не перемальовувати графік якщо нічого не змінилось
        const newDataStr = JSON.stringify(data.history);
        if (newDataStr !== currentStatsData) {
            currentStatsData = newDataStr;
            updateChart(data.history);
        }
    } catch (e) { console.error("Fetch stats error:", e); }
}

function updateChart(history) {
    const ctx = document.getElementById('activityChart').getContext('2d');
    const labels = history.map(h => h.date);
    const success = history.map(h => h.success);
    const failed = history.map(h => h.failed);

    if (chart) {
        chart.data.labels = labels;
        chart.data.datasets[0].data = success;
        chart.data.datasets[1].data = failed;
        chart.update('none'); // Оновлюємо без анімації щоб не відволікати
    } else {
        chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Зібрано Карт',
                        data: success,
                        borderColor: '#10b981',
                        tension: 0.4,
                        fill: true,
                        backgroundColor: 'rgba(16, 185, 129, 0.1)'
                    },
                    {
                        label: 'Помилки',
                        data: failed,
                        borderColor: '#ef4444',
                        tension: 0.4,
                        fill: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

async function fetchUsers() {
    try {
        const res = await fetch('/api/users');
        const users = await res.json();
        const tbody = document.getElementById('usersList');
        tbody.innerHTML = '';

        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.className = 'border-b border-gray-700 hover:bg-gray-800/50 transition';

            // Визначаємо тип користувача для гарного бейджа
            let typeBadge = '';
            if (user.is_blocked) {
                typeBadge = '<span class="badge blocked">🚫 Blocked</span>';
            } else if (user.is_premium) {
                typeBadge = '<span class="badge premium">⭐ Premium</span>';
            } else {
                typeBadge = '<span class="badge trial">🆓 Trial</span>';
            }

            const sessionBadge = user.status === 'ACTIVE'
                ? '<span class="px-2 py-1 rounded text-xs bg-green-500/20 text-green-400">✅ Active</span>'
                : `<span class="px-2 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400">${user.status}</span>`;

            const lastCollect = user.last_collect_at
                ? new Date(user.last_collect_at).toLocaleString('uk-UA')
                : '—';

            tr.innerHTML = `
                <td class="p-4">${user.telegram_id}</td>
                <td class="p-4 font-medium">${user.email || '—'}</td>
                <td class="p-4">${typeBadge}</td>
                <td class="p-4 text-sm">${lastCollect}</td>
                <td class="p-4">${sessionBadge}</td>
                <td class="p-4 text-sm">
                    <button onclick="toggleUserStatus(${user.telegram_id}, 'premium', ${user.is_premium ? 0 : 1})" title="${user.is_premium ? 'Зняти преміум' : 'Дати преміум'}" class="toggle-btn ${user.is_premium ? 'active' : ''}">⭐</button>
                    <button onclick="toggleUserStatus(${user.telegram_id}, 'blocked', ${user.is_blocked ? 0 : 1})" title="${user.is_blocked ? 'Розблокувати' : 'Заблокувати'}" class="toggle-btn ${user.is_blocked ? 'blocked' : ''}">🚫</button>
                    <button onclick="showUserChat(${user.telegram_id})" class="text-blue-400 hover:underline ml-2">Чат</button>
                    <button onclick="checkSession(${user.telegram_id})" class="text-indigo-400 hover:underline ml-2">Перевірка</button>
                    <button onclick="clearHistory(${user.telegram_id})" class="text-red-400 hover:underline ml-2">Очистити</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) { console.error("Fetch users error:", e); }
}

async function showUserChat(userId) {
    document.getElementById('chatUserName').innerText = `Чат користувача: ${userId}`;
    const container = document.getElementById('chatContainer');
    container.innerHTML = 'Завантаження...';
    document.getElementById('chatModal').style.display = 'flex';

    try {
        const res = await fetch(`/api/users/${userId}/chat`);
        const messages = await res.json();
        container.innerHTML = '';

        if (messages.length === 0) {
            container.innerHTML = '<div class="reward-placeholder">Історія повідомлень порожня</div>';
            return;
        }

        messages.forEach(msg => {
            const div = document.createElement('div');
            const text = msg.text || '';
            const isBot = text.startsWith('🤖') || text.includes('🚀') || text.includes('✅') || text.includes('ℹ️') || text.includes('Asphalt');
            div.className = `message ${isBot ? 'msg-bot' : 'msg-user'}`;

            const time = new Date(msg.timestamp).toLocaleString('uk-UA', { hour: '2-digit', minute: '2-digit' });
            div.innerHTML = `
                ${text || '<span class="text-muted">(Медіа або порожньо)</span>'}
                <span class="msg-time">${time}</span>
            `;
            container.appendChild(div);
        });

        container.scrollTop = container.scrollHeight;
    } catch (e) {
        container.innerHTML = 'Помилка завантаження чату.';
    }
}

async function fetchGlobalRewards() {
    try {
        const res = await fetch('/api/config/rewards');
        const data = await res.json();
        const container = document.getElementById('globalRewards-container') || document.getElementById('global-rewards-container');
        if (!container) return;

        if (!data.img1 && !data.img2) {
            container.innerHTML = '<div class="reward-placeholder">Нагороди ще не були зафіксовані ботом.</div>';
            return;
        }

        container.innerHTML = '';
        [data.img1, data.img2].forEach((imgUrl, idx) => {
            if (!imgUrl) return;
            const card = document.createElement('div');
            card.className = 'reward-card';
            card.innerHTML = `
                <div class="reward-img-wrapper">
                    <img src="${imgUrl}" alt="Reward ${idx + 1}">
                </div>
                <div class="reward-info">Подарунок #${idx + 1}</div>
            `;
            container.appendChild(card);
        });
    } catch (e) { }
}

async function fetchGlobalLogs() {
    try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        const list = document.getElementById('globalLogsList');
        list.innerHTML = '';
        logs.forEach(l => {
            const div = document.createElement('div');
            div.className = 'log-item';
            div.innerHTML = `
                <span><span class="log-meta">[${new Date(l.timestamp).toLocaleTimeString()}]</span> <b>${l.user_id}</b>: ${l.action}</span>
                <span class="log-meta">${l.details || ''}</span>
            `;
            list.appendChild(div);
        });
    } catch (e) { }
}

const groupSelect = document.getElementById('broadcastGroup');
const targetInput = document.getElementById('broadcastTarget');

groupSelect.addEventListener('change', () => {
    targetInput.disabled = groupSelect.value !== 'custom';
    if (groupSelect.value === 'custom') targetInput.focus();
});

document.getElementById('sendBroadcastBtn').addEventListener('click', async () => {
    const message = document.getElementById('broadcastMsg').value;
    const targetId = document.getElementById('broadcastTarget').value;
    const targetGroup = document.getElementById('broadcastGroup').value;
    const ttl = document.getElementById('broadcastTTL').value;

    if (!message) return alert('Введіть повідомлення!');

    await fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message,
            target_id: targetGroup === 'custom' ? targetId : null,
            target_group: targetGroup,
            ttl: ttl || null
        })
    });

    showToast('Розсилку поставлено в чергу');
    document.getElementById('broadcastMsg').value = '';
});

async function toggleUserStatus(id, type, value) {
    const body = type === 'premium' ? { is_premium: value } : { is_blocked: value };
    await fetch(`/api/users/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    fetchUsers();
    showToast('Статус успішно оновлено');
}

async function checkSession(id) {
    showToast('Запит на перевірку відправлено...');
    const res = await fetch(`/api/users/${id}/check-session`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
        // Чекаємо поки адмін поллер обробить і поверне результат? 
        // Ні, краще нехай поллер сам пушить в БД, а ми тут просто покажемо статус "В процесі"
        // Або почекаємо 5 сек і покажемо результат з БД.
        setTimeout(async () => {
            const userRes = await fetch('/api/users');
            const users = await userRes.json();
            const user = users.find(u => u.telegram_id === id);
            if (user) {
                const statusStr = user.last_check_status === 'ACTIVE' ? '✅ Сесія активна!' : '❌ Сесія застаріла.';
                showModal('Результат перевірки', `ID: ${id}\nСтатус: ${statusStr}\nЧас: ${new Date(user.last_check_at).toLocaleString()}`);
            }
        }, 5000);
    }
}

function showModal(title, body) {
    document.getElementById('modalTitle').innerText = title;
    document.getElementById('modalBody').innerText = body;
    document.getElementById('resultModal').style.display = 'flex';
}

function closeModal(id) {
    document.getElementById(id || 'resultModal').style.display = 'none';
}

async function clearHistory(id) {
    if (!confirm('Очистити чат юзера?')) return;
    await fetch(`/api/users/${id}/clear-history`, { method: 'POST' });
    showToast('Запит на очищення відправлено');
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerText = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

async function toggleSystemPause() {
    const status = document.getElementById('stat-system-status').innerText;
    const isPaused = status.includes('ПАУЗА');
    const command = isPaused ? 'RESUME_SYSTEM' : 'PAUSE_SYSTEM';

    if (!confirm(`Бажаєте ${isPaused ? 'ВІДНОВИТИ' : 'ЗУПИНИТИ'} роботу всієї системи?`)) return;

    await fetch('/api/system/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
    });

    showToast('Команду відправлено');
    setTimeout(fetchStats, 2000);
}

const templates = {
    downtime: "⚠️ Увага! Спостерігаються технічні збої на стороні Gameloft. Бот автоматично призупинив збір, щоб не допустити помилок. Як тільки проблему буде вирішено — збір продовжиться у порядку черги. Дякуємо за терпіння! 🙏",
    resolved: "✅ Гарні новини! Технічні проблеми усунено. Бот відновлює збір нагород у черговому режимі. 🚀"
};

function applyTemplate(type) {
    document.getElementById('broadcastMsg').value = templates[type] || '';
}

// Initial Load
fetchStats();
fetchGlobalRewards();
setInterval(fetchStats, 60000); // 1 раз на хвилину
fetchUsers();
