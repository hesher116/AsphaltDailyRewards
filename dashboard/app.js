document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    const navButtons = document.querySelectorAll('.nav-btn');
    const sections = document.querySelectorAll('.tab-content');

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;

            navButtons.forEach(b => b.classList.remove('active'));
            sections.forEach(s => s.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(target).classList.add('active');

            if (target === 'users') fetchUsers();
            if (target === 'logs') fetchLogs();
        });
    });

    // Initial load
    fetchStats();

    // Auto-refresh every 30 seconds
    setInterval(fetchStats, 30000);

    // --- API Calls ---

    async function fetchStats() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();

            document.getElementById('stat-total-users').textContent = data.metrics.totalUsers;
            document.getElementById('stat-active-sessions').textContent = data.metrics.activeUsers;
            document.getElementById('stat-premium').textContent = data.metrics.premiumUsers;
            document.getElementById('stat-rewards').textContent = data.metrics.totalCollections;

            initChart(data.history);
        } catch (e) {
            showToast('Помилка завантаження статистики', 'error');
        }
    }

    async function fetchUsers() {
        try {
            const res = await fetch('/api/users');
            const users = await res.json();
            const list = document.getElementById('usersList');
            list.innerHTML = '';

            users.forEach(user => {
                const tr = document.createElement('tr');
                const sessionStatus = user.last_check_status || '—';
                const sessionClass = user.last_check_status === 'ACTIVE' ? 'active' : (user.last_check_status === 'EXPIRED' ? 'pending' : '');

                tr.innerHTML = `
                    <td>${user.telegram_id}</td>
                    <td>${user.email}</td>
                    <td><span class="badge ${user.status === 'ACTIVE' ? 'active' : 'pending'}">${user.status}</span></td>
                    <td><span class="badge ${sessionClass}">${sessionStatus}</span></td>
                    <td>
                        <button class="toggle-btn ${user.is_premium ? 'active' : ''}" onclick="updateUser(${user.telegram_id}, 'premium', ${!user.is_premium})">
                            ${user.is_premium ? 'Так' : 'Ні'}
                        </button>
                    </td>
                    <td>
                        <button class="toggle-btn ${user.is_blocked ? 'blocked' : ''}" onclick="updateUser(${user.telegram_id}, 'block', ${!user.is_blocked})">
                            ${user.is_blocked ? 'Блок' : 'Ні'}
                        </button>
                    </td>
                    <td>
                        <button class="toggle-btn" title="Перевірити сесію" onclick="checkSession(${user.telegram_id})">🛡️</button>
                        ${user.last_check_status === 'EXPIRED' ? `<button class="toggle-btn" title="Повідомити про сесію" onclick="notifyExpired(${user.telegram_id})">⚠️</button>` : ''}
                        <button class="toggle-btn" title="Зібрати зараз" onclick="triggerCollect(${user.telegram_id}, '${user.email}')">🚀</button>
                        <button class="toggle-btn" title="Історія чату" onclick="viewHistory(${user.telegram_id})">💬</button>
                    </td>
                `;
                list.appendChild(tr);
            });
        } catch (e) {
            showToast('Помилка завантаження користувачів', 'error');
        }
    }

    async function fetchLogs() {
        try {
            const res = await fetch('/api/logs');
            const logs = await res.json();
            const list = document.getElementById('logsList');
            list.innerHTML = '';

            logs.forEach(log => {
                const item = document.createElement('div');
                item.className = 'log-item';
                item.innerHTML = `
                    < div class="log-main" >
                        <strong>${log.email || 'System'}</strong>: ${log.status}
                <span class="log-meta">(${log.rewards_collected} rewards)</span>
                    </div >
                    <div class="log-meta">${new Date(log.timestamp).toLocaleString()}</div>
                `;
                list.appendChild(item);
            });
        } catch (e) {
            showToast('Помилка завантаження логів', 'error');
        }
    }

    // --- Actions ---

    window.updateUser = async (id, type, value) => {
        const body = type === 'premium' ? { is_premium: value } : { is_blocked: value };
        try {
            const res = await fetch(`/api/users/${id}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (res.ok) {
                showToast(`Користувача оновлено`, 'success');
                fetchUsers();
                fetchStats();
            }
        } catch (e) {
            showToast('Помилка оновлення', 'error');
        }
    };

    window.checkSession = async (id) => {
        try {
            const res = await fetch(`/api/users/${id}/check-session`, { method: 'POST' });
            if (res.ok) showToast('Запит на перевірку надіслано', 'success');
        } catch (e) { showToast('Помилка', 'error'); }
    };

    window.notifyExpired = async (id) => {
        try {
            const res = await fetch(`/api/users/${id}/notify-expired`, { method: 'POST' });
            if (res.ok) showToast('Користувача повідомлено', 'success');
        } catch (e) { showToast('Помилка', 'error'); }
    };

    window.triggerCollect = async (id, email) => {
        try {
            const res = await fetch(`/api/users/${id}/trigger-collect`, { method: 'POST' });
            if (res.ok) showToast('Запит на збір надіслано', 'success');
        } catch (e) { showToast('Помилка', 'error'); }
    };

    window.viewHistory = async (id) => {
        try {
            const res = await fetch(`/api/users/${id}/history`);
            const history = await res.json();
            let text = history.length ? history.map(h => `ID: ${h.message_id} | ${new Date(h.timestamp).toLocaleString()}`).join('\n') : 'Історія порожня';

            if (confirm(`Останні повідомлення (${history.length}):\n\n${text}\n\nБажаєте очистити історію в боті?`)) {
                const clearRes = await fetch(`/api/users/${id}/clear-history`, { method: 'POST' });
                if (clearRes.ok) showToast('Очищення запущено', 'success');
            }
        } catch (e) { showToast('Помилка завантаження історії', 'error'); }
    }

    document.getElementById('sendBroadcast').addEventListener('click', async () => {
        const msg = document.getElementById('broadcastMsg').value;
        if (!msg) return showToast('Введіть повідомлення', 'warning');

        try {
            const res = await fetch('/api/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
            });
            if (res.ok) {
                showToast('Розсилку запущено', 'success');
                document.getElementById('broadcastMsg').value = '';
            }
        } catch (e) {
            showToast('Помилка відправки', 'error');
        }
    });

    // --- UI Helpers ---

    function showToast(text, type = 'success') {
        const toast = document.getElementById('toast');
        toast.textContent = text;
        toast.style.borderColor = type === 'error' ? 'var(--error)' : 'var(--accent-blue)';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    let activityChart = null;
    function initChart(history) {
        const ctx = document.getElementById('activityChart').getContext('2d');
        const labels = history.map(h => h.date);
        const successData = history.map(h => h.success);
        const failedData = history.map(h => h.failed);

        if (activityChart) activityChart.destroy();

        activityChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Успішно',
                        data: successData,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Помилки',
                        data: failedData,
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        fill: true,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#94a3b8' } }
                },
                scales: {
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
                    x: { grid: { display: false }, ticks: { color: '#94a3b8' } }
                }
            }
        });
    }
});
