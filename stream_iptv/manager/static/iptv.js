        let currentUser = window.IPTV_CONFIG.currentUser;
        window.currentUser = currentUser;
        function getApiUrl(endpoint) {
            const cleanEndpoint = endpoint.replace(/^\//, '');
            let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
            let url = base + cleanEndpoint;
            if (currentUser && currentUser !== "default" && !url.includes('user=')) {
                let sep = url.includes('?') ? '&' : '?';
                url += `${sep}user=${encodeURIComponent(currentUser)}`;
            }
            return url;
        }

        async function safeParseJson(res) {
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                if (text.includes('<!DOCTYPE') || text.includes('<html')) {
                    throw new Error(`Server returned HTML error (${res.status}): Network timeout or gateway proxy error.`);
                }
                throw new Error(`Invalid server response (${res.status}): ${text.substring(0, 100)}`);
            }
        }

        function pollRefreshStatus(onProgress, onComplete, onError) {
            const startTime = Date.now();
            let lastServerContact = Date.now();
            const interval = setInterval(async () => {
                try {
                    const res = await fetch(getApiUrl('api/provider/refresh-status'));
                    if (!res.ok) return;
                    const data = await safeParseJson(res);
                    if (!data) return;
                    lastServerContact = Date.now();

                    if (data.status === 'running') {
                        if (onProgress) onProgress(data.progress || 'Syncing IPTV database...');
                    } else if (data.status === 'completed') {
                        clearInterval(interval);
                        if (onComplete) onComplete(data);
                    } else if (data.status === 'error') {
                        clearInterval(interval);
                        if (onError) onError(data.error || 'Unknown error occurred during IPTV sync');
                    }
                } catch (err) {
                    console.warn('Refresh polling error:', err);
                }

                // Don't abort while the server still reports progress; only give up
                // if we lose contact for 3 minutes or hit a 60-minute hard cap.
                if (Date.now() - lastServerContact > 180000) {
                    clearInterval(interval);
                    if (onError) onError('Lost contact with server while syncing (no status updates for 3 minutes).');
                } else if (Date.now() - startTime > 3600000) {
                    clearInterval(interval);
                    if (onError) onError('Sync timed out after 60 minutes.');
                }
            }, 1500);
        }

        let pageLoadPlaylistVersion = Number(window.IPTV_CONFIG.playlistVersion);
        var _isFormModified = false;
        Object.defineProperty(window, 'isFormModified', {
            get: function() { return _isFormModified; },
            set: function(val) {
                _isFormModified = Boolean(val);
                if (_isFormModified) {
                    if (typeof acquireEditingLock === 'function') acquireEditingLock();
                    if (typeof saveDraftToLocalStorage === 'function') saveDraftToLocalStorage();
                    const badge = document.getElementById('editing-lock-badge');
                    if (badge) badge.style.display = 'inline-flex';
                } else {
                    const badge = document.getElementById('editing-lock-badge');
                    if (badge) badge.style.display = 'none';
                }
            },
            configurable: true
        });

        function safeLogoUrl(rawUrl) {
            if (!rawUrl || typeof rawUrl !== 'string') return '';
            const value = rawUrl.trim();
            if (!value) return '';
            if (value.startsWith('/')) return value;
            if (value.startsWith('http://') || value.startsWith('https://')) {
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                return base + 'api/proxy?url=' + encodeURIComponent(value);
            }
            return value;
        }

        const provChanState = { provider: '', page: 1, pages: 1, total: 0, debounceTimer: null };

        function openProviderChannels(providerName, channelCount) {
            provChanState.provider = providerName;
            provChanState.page = 1;
            const subtitle = document.getElementById('prov-modal-subtitle');
            if (subtitle) {
                subtitle.textContent = `${providerName} • ${(channelCount || 0).toLocaleString()} channels`;
            }
            const sInput = document.getElementById('prov-ch-search');
            if (sInput) sInput.value = '';
            const cSelect = document.getElementById('prov-ch-category');
            if (cSelect) cSelect.innerHTML = '<option value="">All Categories</option>';
            const modal = document.getElementById('provider-channels-modal');
            if (modal) modal.classList.add('active');
            loadProviderChannels(1);
        }

        function closeProviderChannels() {
            const modal = document.getElementById('provider-channels-modal');
            if (modal) modal.classList.remove('active');
        }

        function debounceProvChanSearch() {
            if (provChanState.debounceTimer) clearTimeout(provChanState.debounceTimer);
            provChanState.debounceTimer = setTimeout(() => { loadProviderChannels(1); }, 350);
        }

        async function loadProviderChannels(page) {
            page = Math.max(1, page || 1);
            if (page > provChanState.pages && provChanState.pages > 0) return;
            provChanState.page = page;

            const q = encodeURIComponent((document.getElementById('prov-ch-search')?.value || '').trim());
            const cat = encodeURIComponent(document.getElementById('prov-ch-category')?.value || '');
            const prov = encodeURIComponent(provChanState.provider);
            const userParam = (currentUser && currentUser !== 'default') ? `&user=${encodeURIComponent(currentUser)}` : '';
            const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
            const url = `${base}api/providers/channels?provider=${prov}&q=${q}&category=${cat}&page=${page}&per_page=100${userParam}`;

            const list = document.getElementById('prov-ch-list');
            if (list) list.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--muted);">Loading...</div>';

            try {
                const res = await fetch(url);
                const data = await safeParseJson(res);
                if (!data.success) throw new Error(data.error || 'Failed to load channels');

                provChanState.page = data.page;
                provChanState.pages = data.pages;
                provChanState.total = data.total;

                const countEl = document.getElementById('prov-ch-count');
                if (countEl) countEl.textContent = `${data.total.toLocaleString()} channels`;

                const catSel = document.getElementById('prov-ch-category');
                if (catSel && (catSel.options.length <= 1 || cat === '')) {
                    const currentCat = catSel.value;
                    catSel.innerHTML = '<option value="">All Categories</option>';
                    (data.categories || []).forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c;
                        opt.textContent = c;
                        if (c === currentCat) opt.selected = true;
                        catSel.appendChild(opt);
                    });
                }

                const pageInfo = document.getElementById('prov-ch-page-info');
                if (pageInfo) pageInfo.textContent = `Page ${data.page} of ${data.pages}`;
                const prevBtn = document.getElementById('prov-ch-prev');
                if (prevBtn) prevBtn.disabled = data.page <= 1;
                const nextBtn = document.getElementById('prov-ch-next');
                if (nextBtn) nextBtn.disabled = data.page >= data.pages;

                provChanState.currentChannels = data.channels || [];

                if (!data.channels || data.channels.length === 0) {
                    if (list) list.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--muted);">No channels found.</div>';
                    return;
                }

                const rows = data.channels.map((ch, i) => {
                    const num = ((data.page - 1) * 100) + i + 1;
                    const logoHtml = ch.logo ? `<img src="${escapeHtml(safeLogoUrl(ch.logo))}" style="width:18px;height:14px;object-fit:contain;vertical-align:middle;margin-right:6px;border-radius:2px;" onerror="this.style.display='none'">` : '';
                    const statusHtml = renderChannelStatusBadge(ch);
                    const pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
                    const inPlaylist = pd && pd.streams && pd.streams.some(s => s.url === ch.url);
                    const addBtnText = inPlaylist ? '✓ Added' : '+ Add';
                    const addBtnStyle = inPlaylist ? 'padding:3px 8px;font-size:10px;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:5px;cursor:pointer;font-weight:600;white-space:nowrap;' : 'padding:3px 8px;font-size:10px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:5px;cursor:pointer;font-weight:600;white-space:nowrap;';
                    return `<tr id="prov-ch-row-${ch.id}" style="border-bottom:1px solid var(--line);" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">` +
                        `<td style="padding:7px 10px;color:var(--muted);font-size:11px;">${num}</td>` +
                        `<td style="padding:7px 10px;font-weight:500;color:var(--ink);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(ch.name)}">${logoHtml}${escapeHtml(ch.name)}</td>` +
                        `<td style="padding:7px 10px;color:var(--muted);font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(ch.category || '')}">${escapeHtml(ch.category || '—')}</td>` +
                        `<td id="prov-ch-status-${ch.id}" style="padding:7px 10px;text-align:center;white-space:nowrap;">${statusHtml}</td>` +
                        `<td style="padding:7px 10px;text-align:right;white-space:nowrap;">` +
                            `<button type="button" id="btn-verify-${ch.id}" onclick="verifySingleChannel(${ch.id}, this)" style="padding:3px 7px;font-size:10px;background:#f8fafc;color:#475569;border:1px solid #cbd5e1;border-radius:5px;cursor:pointer;font-weight:600;margin-right:5px;" title="Check stream playability now">⚡ Check</button>` +
                            `<div style="display:inline-flex;vertical-align:middle;margin-right:6px;border-radius:5px;overflow:hidden;border:1px solid #cbd5e1;box-shadow:0 1px 2px rgba(0,0,0,0.04);">` +
                                `<button type="button" onclick="openTestPlayer(this.dataset.url, this.dataset.name, this.dataset.category)" data-url="${escapeHtml(ch.url)}" data-name="${escapeHtml(ch.name)}" data-category="${escapeHtml(ch.category || '')}" style="padding:3px 7px;font-size:10px;background:#f1f5f9;color:#334155;border:none;border-right:1px solid #cbd5e1;cursor:pointer;font-weight:600;white-space:nowrap;" title="Test stream in embedded preview modal">▶ Test</button>` +
                                `<button type="button" onclick="openStandalonePlayer(this.dataset.url)" data-url="${escapeHtml(ch.url)}" style="padding:3px 6px;font-size:10px;background:#ffffff;color:#475569;border:none;cursor:pointer;font-weight:600;display:inline-flex;align-items:center;gap:2px;" title="Open directly in dedicated full player tab">↗ Player</button>` +
                            `</div>` +
                            `<button type="button" onclick="addProviderChannelToPlaylist(this.dataset.name, this.dataset.url, this.dataset.category, this)" data-url="${escapeHtml(ch.url)}" data-name="${escapeHtml(ch.name)}" data-category="${escapeHtml(ch.category || '')}" style="${addBtnStyle}">${addBtnText}</button>` +
                        `</td>` +
                        `</tr>`;
                }).join('');

                if (list) {
                    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;">` +
                        `<thead style="position:sticky;top:0;background:#f1f5f9;z-index:1;"><tr style="border-bottom:1px solid var(--line);">` +
                        `<th style="text-align:left;padding:8px 10px;font-weight:600;color:var(--muted);font-size:11px;width:36px;">#</th>` +
                        `<th style="text-align:left;padding:8px 10px;font-weight:600;color:var(--muted);font-size:11px;">Channel Name</th>` +
                        `<th style="text-align:left;padding:8px 10px;font-weight:600;color:var(--muted);font-size:11px;width:120px;">Category</th>` +
                        `<th style="text-align:center;padding:8px 10px;font-weight:600;color:var(--muted);font-size:11px;width:110px;">Status</th>` +
                        `<th style="text-align:right;padding:8px 10px;font-weight:600;color:var(--muted);font-size:11px;width:210px;">Action</th>` +
                        `</tr></thead><tbody>${rows}</tbody></table>`;
                }
            } catch (err) {
                if (list) list.innerHTML = `<div style="padding:20px;text-align:center;color:#ef4444;">Error: ${escapeHtml(err.message)}</div>`;
            }
        }

        function renderChannelStatusBadge(ch) {
            if (ch.is_playable === 1) {
                const lat = ch.latency_ms !== null && ch.latency_ms !== undefined ? `${ch.latency_ms}ms` : 'ok';
                return `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;background:#dcfce7;color:#15803d;border:1px solid #bbf7d0;" title="Live (${lat})&#10;Last checked: ${escapeHtml(ch.last_checked || 'recently')}">🟢 Live (${lat})</span>`;
            } else if (ch.is_playable === 0) {
                const err = escapeHtml(ch.error_msg || 'Offline / unreachable');
                const chId = ch.id ? Number(ch.id) : null;
                const retryBtn = chId ? `<button type="button" onclick="verifySingleChannel(${chId}, this)" style="padding:1px 5px;font-size:9px;background:#ffffff;color:#b91c1c;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;font-weight:700;" title="Re-check stream playability">Retry</button>` : '';
                return `<div style="display:inline-flex;align-items:center;gap:4px;justify-content:center;">` +
                    `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;" title="${err}&#10;Last checked: ${escapeHtml(ch.last_checked || 'recently')}">🔴 Offline</span>` +
                    retryBtn +
                `</div>`;
            }
            return `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:500;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;" title="Untested stream">⚪ Untested</span>`;
        }

        async function verifySingleChannel(id, btn) {
            if (!id) return;
            const originalText = btn ? btn.innerHTML : '⚡ Check';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '⏳ ...';
            }
            const statusCell = document.getElementById(`prov-ch-status-${id}`);
            const searchBadge = document.getElementById(`iptv-search-status-${id}`);
            if (statusCell) statusCell.innerHTML = '<span style="font-size:10px;color:var(--muted);">⏳ Checking...</span>';
            if (searchBadge) searchBadge.innerHTML = '<span style="font-size:10px;color:var(--muted);">⏳ Checking...</span>';

            try {
                const res = await fetch(getApiUrl('api/channels/verify'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: id })
                });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    if (statusCell) statusCell.innerHTML = renderChannelStatusBadge(data);
                    if (searchBadge) searchBadge.innerHTML = renderChannelStatusBadge(data);
                    if (window.currentIptvSearchResults) {
                        const m = window.currentIptvSearchResults.find(c => c.id === id);
                        if (m) {
                            m.is_playable = data.is_playable;
                            m.latency_ms = data.latency_ms;
                            m.last_checked = data.last_checked;
                            m.error_msg = data.error_msg;
                        }
                    }
                    if (data.is_playable === 1) {
                        showToast(`🟢 Channel #${id} is LIVE (${data.latency_ms}ms)`);
                    } else {
                        showToast(`🔴 Channel #${id} OFFLINE (${data.error_msg || 'Error'})`);
                    }
                } else {
                    const errMsg = (data && data.error) || 'Check failed';
                    if (statusCell) statusCell.innerHTML = `<span style="font-size:10px;color:#ef4444;" title="${escapeHtml(errMsg)}">⚠️ Error</span>`;
                    if (searchBadge) searchBadge.innerHTML = `<span style="font-size:10px;color:#ef4444;" title="${escapeHtml(errMsg)}">⚠️ Error</span>`;
                }
            } catch (err) {
                if (statusCell) statusCell.innerHTML = `<span style="font-size:10px;color:#ef4444;" title="${escapeHtml(err.message)}">⚠️ Error</span>`;
                if (searchBadge) searchBadge.innerHTML = `<span style="font-size:10px;color:#ef4444;" title="${escapeHtml(err.message)}">⚠️ Error</span>`;
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            }
        }

        async function verifyIptvSearchChannel(ch, btn, badgeEl) {
            if (!ch) return;
            const origHtml = btn ? btn.innerHTML : '⚡ Verify';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '⏳ ...';
            }
            if (badgeEl) {
                badgeEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">⏳ Checking...</span>';
            }
            try {
                const payload = ch.id ? { id: ch.id, url: ch.url } : { url: ch.url };
                const res = await fetch(getApiUrl('api/channels/verify'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    ch.is_playable = data.is_playable;
                    ch.latency_ms = data.latency_ms;
                    ch.last_checked = data.last_checked;
                    ch.error_msg = data.error_msg;
                    if (badgeEl) badgeEl.innerHTML = renderChannelStatusBadge(data);
                    if (ch.id) {
                        const statusCell = document.getElementById(`prov-ch-status-${ch.id}`);
                        if (statusCell) statusCell.innerHTML = renderChannelStatusBadge(data);
                    }
                    if (data.is_playable === 1) {
                        showToast(`🟢 ${ch.name || 'Channel'} is LIVE (${data.latency_ms}ms)`);
                    } else {
                        showToast(`🔴 ${ch.name || 'Channel'} OFFLINE: ${data.error_msg || 'Unreachable'}`);
                    }
                } else {
                    if (badgeEl) badgeEl.innerHTML = `<span style="font-size:10px;color:#ef4444;">⚠️ Failed</span>`;
                }
            } catch (err) {
                if (badgeEl) badgeEl.innerHTML = `<span style="font-size:10px;color:#ef4444;">⚠️ Error</span>`;
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = origHtml;
                }
            }
        }

        async function verifyVisibleIptvSearchResults() {
            const btn = document.getElementById('iptv-search-verify-btn');
            const items = window.currentIptvSearchResults || [];
            if (!items.length) {
                showToast('No search results to verify', 'info');
                return;
            }
            const itemsToVerify = items.filter(c => c.id).slice(0, 100);
            if (!itemsToVerify.length) {
                showToast('No channels with database IDs found to verify', 'info');
                return;
            }

            const origHtml = btn ? btn.innerHTML : '⚡ Verify Visible';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `⏳ Verifying ${itemsToVerify.length}...`;
            }

            itemsToVerify.forEach(c => {
                const badge = document.getElementById(`iptv-search-status-${c.id}`);
                if (badge) badge.innerHTML = '<span style="font-size:10px;color:var(--muted);">⏳ ...</span>';
            });

            try {
                const res = await fetch(getApiUrl('api/channels/verify_batch'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: itemsToVerify.map(c => c.id) })
                });
                const data = await safeParseJson(res);
                if (data && data.success && Array.isArray(data.results)) {
                    let liveCount = 0;
                    data.results.forEach(r => {
                        const badge = document.getElementById(`iptv-search-status-${r.id}`);
                        if (badge) badge.innerHTML = renderChannelStatusBadge(r);
                        const statusCell = document.getElementById(`prov-ch-status-${r.id}`);
                        if (statusCell) statusCell.innerHTML = renderChannelStatusBadge(r);
                        const matched = items.find(c => c.id === r.id);
                        if (matched) {
                            matched.is_playable = r.is_playable;
                            matched.latency_ms = r.latency_ms;
                            matched.last_checked = r.last_checked;
                            matched.error_msg = r.error_msg;
                        }
                        if (r.is_playable === 1) liveCount++;
                    });
                    showToast(`⚡ Batch verified: ${liveCount}/${data.results.length} live`);
                } else {
                    showToast('Batch verification failed: ' + ((data && data.error) || 'Unknown error'), 'danger');
                }
            } catch (err) {
                showToast('Batch verification failed: ' + err.message, 'danger');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = origHtml;
                }
            }
        }

        async function verifyVisibleChannels() {
            const channels = provChanState.currentChannels || [];
            if (!channels.length) {
                showToast('No channels to verify on this page.');
                return;
            }
            const ids = channels.map(c => c.id).filter(Boolean);
            if (!ids.length) return;

            const btn = document.getElementById('prov-ch-verify-page-btn');
            const originalText = btn ? btn.innerHTML : '⚡ Verify Page';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `⏳ Verifying ${ids.length}...`;
            }

            ids.forEach(id => {
                const el = document.getElementById(`prov-ch-status-${id}`);
                if (el) el.innerHTML = '<span style="font-size:10px;color:var(--muted);">⏳ Checking...</span>';
            });

            try {
                const res = await fetch(getApiUrl('api/channels/verify_batch'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: ids })
                });
                const data = await safeParseJson(res);
                if (data && data.success && Array.isArray(data.results)) {
                    let liveCount = 0;
                    let deadCount = 0;
                    data.results.forEach(res => {
                        const cell = document.getElementById(`prov-ch-status-${res.id}`);
                        if (cell) cell.innerHTML = renderChannelStatusBadge(res);
                        if (res.is_playable === 1) liveCount++;
                        else deadCount++;
                    });
                    showToast(`Scan complete: 🟢 ${liveCount} Live, 🔴 ${deadCount} Offline`);
                } else {
                    showToast('⚠️ Batch verification failed: ' + ((data && data.error) || 'Unknown error'));
                }
            } catch (err) {
                showToast('⚠️ Batch verification error: ' + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            }
        }

        // Live stream playback listener: auto-heals status when stream plays in preview or standalone player
        function onStreamConfirmedPlayback(streamUrl, isLive) {
            if (!streamUrl) return;
            const channels = (provChanState && provChanState.currentChannels) ? provChanState.currentChannels : [];
            channels.forEach(ch => {
                if (ch.url === streamUrl || (ch.url && streamUrl.includes(ch.url)) || streamUrl.includes(encodeURIComponent(ch.url))) {
                    ch.is_playable = isLive ? 1 : 0;
                    if (isLive) ch.error_msg = null;
                    const cell = document.getElementById(`prov-ch-status-${ch.id}`);
                    if (cell) cell.innerHTML = renderChannelStatusBadge(ch);

                    // Sync playability to database in background
                    fetch(getApiUrl('api/channels/verify'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: ch.id, force_playable: isLive ? 1 : 0, latency_ms: 120 })
                    }).catch(e => console.warn('Could not sync confirmed playability:', e));
                }
            });

            // Update search results
            const searchResults = (typeof currentIptvSearchResults !== 'undefined' && currentIptvSearchResults) ? currentIptvSearchResults : (window.currentIptvSearchResults || []);
            searchResults.forEach(ch => {
                if (ch.url === streamUrl || (ch.url && streamUrl.includes(ch.url)) || streamUrl.includes(encodeURIComponent(ch.url))) {
                    ch.is_playable = isLive ? 1 : 0;
                    if (isLive) ch.error_msg = null;
                    const cell = document.getElementById(`iptv-search-status-${ch.id}`);
                    if (cell) cell.innerHTML = renderChannelStatusBadge(ch);
                }
            });

            // Check active playlist
            const pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
            if (pd && Array.isArray(pd.streams)) {
                let modified = false;
                pd.streams.forEach(s => {
                    if (s.url === streamUrl || (s.url && streamUrl.includes(s.url))) {
                        if (isLive && (s.offline || s.is_offline)) {
                            delete s.offline;
                            delete s.is_offline;
                            delete s.last_error;
                            modified = true;
                        }
                    }
                });
                if (modified) {
                    if (typeof updateOfflineVisibility === 'function') updateOfflineVisibility();
                    if (typeof showToast === 'function') showToast('🟢 Stream confirmed playable! Restored from offline list.');
                }
            }
        }

        window.addEventListener('message', function(e) {
            if (!e.data) return;
            if (e.data.type === 'stream_playing' && e.data.url) {
                onStreamConfirmedPlayback(e.data.url, true);
            } else if (e.data.type === 'stream_failed' && e.data.url) {
                onStreamConfirmedPlayback(e.data.url, false);
            }
        });

        async function addProviderChannelToPlaylist(name, url, category = 'Live TV', btnEl = null) {
            let pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
            if (!pd) {
                const el = document.getElementById('playlist-data');
                if (el) {
                    try {
                        pd = JSON.parse(el.textContent);
                        window.playlistData = pd;
                        if (typeof playlistData !== 'undefined') playlistData = pd;
                    } catch (e) {}
                }
            }
            if (!pd || !Array.isArray(pd.streams)) {
                if (typeof showToast === 'function') showToast('⚠️ Loading playlist data, please try again.');
                else alert('Loading playlist data, please try again.');
                return;
            }
            const exists = pd.streams.some(s => s.url === url);
            if (exists) {
                if (typeof showToast === 'function') showToast('⚠️ Channel already in playlist.');
                else alert('Channel already in playlist.');
                if (typeof updateTestPlayerAddButtonState === 'function') updateTestPlayerAddButtonState();
                if (btnEl) {
                    btnEl.textContent = '✓ Added';
                    btnEl.style.background = '#dcfce7';
                    btnEl.style.color = '#15803d';
                    btnEl.style.borderColor = '#86efac';
                }
                return;
            }
            pd.streams.push({
                name: name,
                url: url,
                type: 'iptv',
                category: category || 'Live TV',
                schedule_type: 'permanent'
            });
            window.playlistData = pd;
            if (typeof playlistData !== 'undefined') playlistData = pd;
            window.isFormModified = true;
            if (typeof isFormModified !== 'undefined') isFormModified = true;
            if (typeof renderCategorizedGrid === 'function') renderCategorizedGrid();
            if (typeof showToast === 'function') showToast(`✅ Added: ${name}`);
            else alert(`Added: ${name}`);
            if (typeof updateTestPlayerAddButtonState === 'function') updateTestPlayerAddButtonState();

            if (btnEl) {
                btnEl.textContent = '✓ Added';
                btnEl.style.background = '#dcfce7';
                btnEl.style.color = '#15803d';
                btnEl.style.borderColor = '#86efac';
            }
            try {
                document.querySelectorAll('#prov-ch-list button[data-url]').forEach(b => {
                    if (b.dataset.url === url) {
                        b.textContent = '✓ Added';
                        b.style.background = '#dcfce7';
                        b.style.color = '#15803d';
                        b.style.borderColor = '#86efac';
                    }
                });
            } catch (domErr) {}

            // Automatically persist to backend so channel is saved immediately
            try {
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const userParam = (typeof currentUser !== 'undefined' && currentUser && currentUser !== 'default') ? `?user=${encodeURIComponent(currentUser)}` : '';
                const saveRes = await fetch(`${base}api/playlist${userParam}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pd)
                });
                const saveResult = await saveRes.json();
                if (saveResult && saveResult.version) {
                    pageLoadPlaylistVersion = saveResult.version;
                    lastUserSaveTimestamp = Date.now();
                    window.isFormModified = false;
                    if (typeof isFormModified !== 'undefined') isFormModified = false;
                }
            } catch (saveErr) {
                console.warn('Auto-save after channel add failed:', saveErr);
            }
        }

        window.openProviderChannels = openProviderChannels;
        window.closeProviderChannels = closeProviderChannels;
        window.debounceProvChanSearch = debounceProvChanSearch;
        window.loadProviderChannels = loadProviderChannels;
        window.addProviderChannelToPlaylist = addProviderChannelToPlaylist;
        window.renderChannelStatusBadge = renderChannelStatusBadge;
        window.verifySingleChannel = verifySingleChannel;
        window.verifyVisibleChannels = verifyVisibleChannels;
        window.verifyIptvSearchChannel = verifyIptvSearchChannel;
        window.verifyVisibleIptvSearchResults = verifyVisibleIptvSearchResults;

        // ── Verify All Channels (SSE) ─────────────────────────────────────────
        let _verifyAllEvtSrc = null;
        let _verifyAllStartTime = null;
        let _verifyProviderState = {};

        function startVerifyAllChannels(opts) {
            opts = opts || {};
            const force = opts.force ? '1' : '0';
            const workers = opts.workers || 30;
            const timeout = opts.timeout || 3.5;
            const provider = opts.provider || '';

            const panel    = document.getElementById('verify-all-panel');
            const btnStart = document.getElementById('btn-verify-all');
            const btnStop  = document.getElementById('btn-stop-verify');
            const barEl    = document.getElementById('verify-all-bar');
            const pctEl    = document.getElementById('verify-all-pct');
            const doneEl   = document.getElementById('verify-stat-done');
            const totalEl  = document.getElementById('verify-stat-total');
            const liveEl   = document.getElementById('verify-stat-live');
            const deadEl   = document.getElementById('verify-stat-dead');
            const titleEl  = document.getElementById('verify-all-title');
            const rateEl   = document.getElementById('verify-all-rate');
            const curProvEl= document.getElementById('verify-current-provider');
            const barsEl   = document.getElementById('verify-provider-bars');

            // Reset UI
            panel.style.display = 'block';
            btnStart.style.display = 'none';
            btnStop.style.display  = 'inline-flex';
            barEl.style.width = '0%';
            pctEl.textContent = '0%';
            doneEl.textContent = '0';
            totalEl.textContent = '—';
            liveEl.textContent = '0';
            deadEl.textContent = '0';
            titleEl.textContent = 'Scanning all channels...';
            rateEl.textContent = '';
            curProvEl.textContent = '';
            barsEl.innerHTML = '';
            _verifyProviderState = {};
            _verifyAllStartTime = Date.now();

            const base = getApiUrl('api/channels/verify_all');
            const params = new URLSearchParams({ force, workers, timeout });
            if (provider) params.set('provider', provider);
            const url = base + '?' + params.toString();

            if (_verifyAllEvtSrc) { try { _verifyAllEvtSrc.close(); } catch(e){} }
            _verifyAllEvtSrc = new EventSource(url);

            _verifyAllEvtSrc.addEventListener('start', e => {
                const d = JSON.parse(e.data);
                totalEl.textContent = (d.total || 0).toLocaleString();
                // Pre-render provider rows
                (d.providers || []).forEach(prov => {
                    const pTotal = (d.provider_totals || {})[prov] || 0;
                    _verifyProviderState[prov] = { total: pTotal, done: 0, live: 0, dead: 0 };
                    const rowId = 'vpbar-' + btoa(prov).replace(/[^a-z0-9]/gi,'');
                    const skip = pTotal === 0;
                    barsEl.insertAdjacentHTML('beforeend', `
                        <div id="${rowId}" style="background:#1e293b;border-radius:6px;padding:6px 8px;opacity:${skip?'0.4':'1'}">
                            <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;margin-bottom:3px;">
                                <span style="font-weight:600;color:#cbd5e1;">${escapeHtml(prov)}</span>
                                <span id="${rowId}-stats">${skip ? 'already verified' : (pTotal.toLocaleString() + ' to check')}</span>
                            </div>
                            <div style="background:#0f172a;border-radius:4px;height:5px;overflow:hidden;">
                                <div id="${rowId}-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a78bfa);border-radius:4px;transition:width 0.3s ease;"></div>
                            </div>
                        </div>`);
                });
            });

            _verifyAllEvtSrc.addEventListener('provider_start', e => {
                const d = JSON.parse(e.data);
                curProvEl.textContent = '⚡ ' + d.provider;
            });

            _verifyAllEvtSrc.addEventListener('progress', e => {
                const d = JSON.parse(e.data);
                // Update overall
                const pct = d.total > 0 ? Math.round(d.total_done / d.total * 100) : 0;
                barEl.style.width = pct + '%';
                pctEl.textContent = pct + '%';
                doneEl.textContent = (d.total_done || 0).toLocaleString();
                liveEl.textContent = (d.live || 0).toLocaleString();
                deadEl.textContent = (d.dead || 0).toLocaleString();
                curProvEl.textContent = '⚡ ' + d.provider + ' (' + d.prov_done.toLocaleString() + '/' + d.prov_total.toLocaleString() + ')';
                // Rate
                const elapsed = (Date.now() - _verifyAllStartTime) / 1000;
                const rate = elapsed > 0 ? Math.round(d.total_done / elapsed) : 0;
                rateEl.textContent = rate + ' ch/s · ' + Math.round(elapsed) + 's elapsed';
                // Per-provider bar
                const rowId = 'vpbar-' + btoa(d.provider).replace(/[^a-z0-9]/gi,'');
                const provBar = document.getElementById(rowId + '-bar');
                const provStats = document.getElementById(rowId + '-stats');
                if (provBar) {
                    const pPct = d.prov_total > 0 ? Math.round(d.prov_done / d.prov_total * 100) : 0;
                    provBar.style.width = pPct + '%';
                }
                if (provStats) {
                    provStats.style.color = '#a78bfa';
                    provStats.textContent = d.prov_done.toLocaleString() + '/' + d.prov_total.toLocaleString() + ' · 🟢' + d.prov_live + ' 🔴' + d.prov_dead;
                }
            });

            _verifyAllEvtSrc.addEventListener('provider_done', e => {
                const d = JSON.parse(e.data);
                const rowId = 'vpbar-' + btoa(d.provider).replace(/[^a-z0-9]/gi,'');
                const provBar = document.getElementById(rowId + '-bar');
                const provStats = document.getElementById(rowId + '-stats');
                if (provBar) { provBar.style.width = '100%'; provBar.style.background = '#10b981'; }
                if (provStats) {
                    const pct = d.total > 0 ? Math.round(d.live / d.total * 100) : 0;
                    provStats.style.color = '#10b981';
                    provStats.textContent = '✓ ' + d.total.toLocaleString() + ' done · 🟢' + d.live.toLocaleString() + ' (' + pct + '%) 🔴' + d.dead.toLocaleString();
                }
            });

            _verifyAllEvtSrc.addEventListener('provider_skip', e => {
                const d = JSON.parse(e.data);
                const rowId = 'vpbar-' + btoa(d.provider).replace(/[^a-z0-9]/gi,'');
                const provBar = document.getElementById(rowId + '-bar');
                if (provBar) { provBar.style.width = '100%'; provBar.style.background = '#475569'; }
            });

            _verifyAllEvtSrc.addEventListener('done', e => {
                const d = JSON.parse(e.data);
                _verifyAllEvtSrc.close();
                _verifyAllEvtSrc = null;
                barEl.style.width = '100%';
                pctEl.textContent = '100%';
                doneEl.textContent = (d.completed || 0).toLocaleString();
                liveEl.textContent = (d.live || 0).toLocaleString();
                deadEl.textContent = (d.dead || 0).toLocaleString();
                curProvEl.textContent = '';
                const elapsed = ((Date.now() - _verifyAllStartTime) / 1000).toFixed(1);
                const pct = d.completed > 0 ? Math.round(d.live / d.completed * 100) : 0;
                titleEl.textContent = `✅ Done — ${(d.completed||0).toLocaleString()} checked · ${pct}% live`;
                rateEl.textContent = elapsed + 's total';
                btnStart.style.display = 'inline-flex';
                btnStop.style.display  = 'none';
                loadProviderConfig(); // refresh provider badges
            });

            _verifyAllEvtSrc.addEventListener('error', e => {
                try { const d = JSON.parse(e.data); titleEl.textContent = '❌ Error: ' + d.message; } catch(ex){}
                _verifyAllEvtSrc.close();
                _verifyAllEvtSrc = null;
                btnStart.style.display = 'inline-flex';
                btnStop.style.display  = 'none';
            });

            _verifyAllEvtSrc.onerror = () => {
                if (_verifyAllEvtSrc && _verifyAllEvtSrc.readyState === EventSource.CLOSED) {
                    btnStart.style.display = 'inline-flex';
                    btnStop.style.display  = 'none';
                }
            };
        }

        function stopVerifyAllChannels() {
            if (_verifyAllEvtSrc) {
                _verifyAllEvtSrc.close();
                _verifyAllEvtSrc = null;
            }
            const btnStart = document.getElementById('btn-verify-all');
            const btnStop  = document.getElementById('btn-stop-verify');
            const titleEl  = document.getElementById('verify-all-title');
            if (btnStart) btnStart.style.display = 'inline-flex';
            if (btnStop)  btnStop.style.display  = 'none';
            if (titleEl)  titleEl.textContent = '⏹ Stopped by user';
        }

        function triggerVerifyAllFromHeader() {
            if (typeof switchPortalTab === 'function') {
                switchPortalTab('studio');
            }
            setTimeout(() => {
                const panel = document.getElementById('verify-all-panel');
                if (panel) {
                    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                startVerifyAllChannels();
            }, 150);
        }

        window.triggerVerifyAllFromHeader = triggerVerifyAllFromHeader;
        window.startVerifyAllChannels = startVerifyAllChannels;
        window.stopVerifyAllChannels  = stopVerifyAllChannels;
        // ── End Verify All ────────────────────────────────────────────────────

        async function triggerPlaylistHealthCheck() {
            const btn = document.getElementById('btn-header-heal-playlist');
            const origHtml = btn ? btn.innerHTML : '🩺 Pre-Flight Check & Heal';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '⏳ Probing & Healing Feeds...';
                btn.style.opacity = '0.8';
            }

            const toast = document.getElementById('toast');
            if (toast) {
                toast.textContent = '🩺 Starting pre-flight health check & self-healing on active playlist...';
                toast.style.display = 'block';
                setTimeout(() => { if (toast.textContent.includes('Starting')) toast.style.display = 'none'; }, 4000);
            }

            try {
                const res = await fetch(getApiUrl('api/playlist/verify'), { method: 'POST' });
                const data = await res.json();

                let pollCount = 0;
                const pollInterval = setInterval(async () => {
                    pollCount++;
                    try {
                        const sRes = await fetch(getApiUrl('api/playlist/verify-status'));
                        const sData = await sRes.json();
                        if (sData.status === 'done') {
                            clearInterval(pollInterval);
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = '✅ Healed & Synced';
                                btn.style.background = '#059669';
                                setTimeout(() => {
                                    btn.innerHTML = origHtml;
                                    btn.style.background = '#2563eb';
                                }, 6000);
                            }
                            if (toast) {
                                toast.textContent = sData.summary || '✅ Playlist pre-flight check complete! Channels updated.';
                                toast.style.display = 'block';
                                setTimeout(() => { toast.style.display = 'none'; }, 5000);
                            }
                            setTimeout(() => { location.reload(); }, 1800);
                        } else if (sData.status === 'error') {
                            clearInterval(pollInterval);
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = origHtml;
                                btn.style.opacity = '1';
                            }
                            if (toast) {
                                toast.textContent = `❌ Health check error: ${sData.error || 'Failed'}`;
                                toast.style.display = 'block';
                                setTimeout(() => { toast.style.display = 'none'; }, 5000);
                            }
                        } else if (pollCount > 90) { // 180s timeout
                            clearInterval(pollInterval);
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = origHtml;
                                btn.style.opacity = '1';
                            }
                        }
                    } catch (pollErr) {
                        console.warn('Verify status polling error:', pollErr);
                    }
                }, 2000);
            } catch (err) {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = origHtml;
                    btn.style.opacity = '1';
                }
                if (toast) {
                    toast.textContent = `❌ Failed to start check: ${err.message}`;
                    toast.style.display = 'block';
                    setTimeout(() => { toast.style.display = 'none'; }, 5000);
                }
            }
        }
        window.triggerPlaylistHealthCheck = triggerPlaylistHealthCheck;



        async function loadProviderConfig() {
            try {
                const res = await fetch(getApiUrl('api/providers'));
                const data = await res.json();
                const container = document.getElementById('providers-list');
                const badge = document.getElementById('provider-status-badge');
                const resetBtn = document.getElementById('btn-reset-provider');
                const totalSpan = document.getElementById('provider-total-channels');

                if (totalSpan && data.total_channels !== undefined) {
                    totalSpan.textContent = `Total: ${data.total_channels.toLocaleString()} channels in DB`;
                }

                const refreshMeta = data.last_refresh || {};

                // Populate the database status panel (Last Run / Last Successful Run / Error)
                const fmtDbTime = (epoch) => {
                    if (!epoch) return '—';
                    const d = new Date(epoch * 1000);
                    const now = new Date();
                    const isToday = d.toDateString() === now.toDateString();
                    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    return isToday ? `Today at ${t}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${t}`;
                };
                const lastRunEl = document.getElementById('db-status-last-run');
                if (lastRunEl) {
                    if (refreshMeta.status === 'running') {
                        lastRunEl.textContent = `⏳ Running since ${fmtDbTime(refreshMeta.started_at)} — ${refreshMeta.progress || 'syncing...'}`;
                        lastRunEl.style.color = '#b45309';
                    } else {
                        const when = refreshMeta.finished_at || refreshMeta.started_at;
                        const statusIcon = refreshMeta.status === 'error' ? '❌' : (refreshMeta.status === 'completed' ? '✅' : '');
                        lastRunEl.textContent = when ? `${statusIcon} ${fmtDbTime(when)}`.trim() : '—';
                        lastRunEl.style.color = refreshMeta.status === 'error' ? '#dc2626' : 'var(--ink)';
                    }
                }
                const lastSuccessEl = document.getElementById('db-status-last-success');
                if (lastSuccessEl) {
                    let txt = fmtDbTime(refreshMeta.last_success_at);
                    if (refreshMeta.last_success_at && refreshMeta.status === 'completed' && refreshMeta.total_channels) {
                        txt += ` (${refreshMeta.total_channels.toLocaleString()} channels)`;
                    }
                    lastSuccessEl.textContent = txt;
                }
                const errorEl = document.getElementById('db-status-error');
                if (errorEl) {
                    if (refreshMeta.status === 'error' && (refreshMeta.error || refreshMeta.last_error)) {
                        errorEl.textContent = `${refreshMeta.error || refreshMeta.last_error} (${fmtDbTime(refreshMeta.last_error_at || refreshMeta.finished_at)})`;
                        errorEl.style.color = '#dc2626';
                    } else {
                        errorEl.textContent = 'None';
                        errorEl.style.color = '#16a34a';
                    }
                }

                if (refreshMeta.finished_at) {
                    const d = new Date(refreshMeta.finished_at * 1000);
                    const now = new Date();
                    const isToday = d.toDateString() === now.toDateString();
                    const timeFormatted = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    const fullDate = isToday ? `Today at ${timeFormatted}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeFormatted}`;
                    
                    const headerRefresh = document.getElementById('header-db-last-refresh-time');
                    if (headerRefresh) headerRefresh.textContent = fullDate;

                    const modalMeta = document.getElementById('provider-last-refresh-meta');
                    if (modalMeta) {
                        const total = refreshMeta.total_channels ? ` (${refreshMeta.total_channels.toLocaleString()} channels)` : '';
                        modalMeta.textContent = `Last Synced: ${fullDate}${total}`;
                    }

                    const refreshBtns = document.querySelectorAll('.btn-refresh-iptv');
                    refreshBtns.forEach(b => {
                        b.title = `Last DB refresh: ${fullDate}. Click to re-sync provider streams.`;
                    });
                }

                if (data.is_custom || (data.providers && data.providers.length > 1)) {
                    if (badge) {
                        badge.innerText = `${data.providers.length} Provider(s) Active`;
                        badge.style.background = 'rgba(59, 130, 246, 0.15)';
                        badge.style.color = '#60a5fa';
                        badge.style.borderColor = 'rgba(59, 130, 246, 0.3)';
                    }
                    if (resetBtn) resetBtn.style.display = 'inline-block';
                } else {
                    if (badge) {
                        badge.innerText = 'Default Provider Active';
                        badge.style.background = 'rgba(16, 185, 129, 0.15)';
                        badge.style.color = '#34d399';
                        badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                    }
                    if (resetBtn) resetBtn.style.display = 'none';
                }

                if (!container) return;
                container.innerHTML = '';

                if (!data.providers || data.providers.length === 0) {
                    container.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--muted); font-size: 12px;">No providers configured.</div>';
                    return;
                }

                data.providers.forEach((prov, idx) => {
                    const row = document.createElement('div');
                    row.style.background = '#ffffff';
                    row.style.border = '1px solid var(--line)';
                    row.style.borderRadius = '10px';
                    row.style.padding = '10px 14px';
                    row.style.display = 'flex';
                    row.style.alignItems = 'center';
                    row.style.justifyContent = 'space-between';
                    row.style.gap = '12px';
                    row.style.flexWrap = 'wrap';

                    const info = document.createElement('div');
                    info.style.display = 'flex';
                    info.style.alignItems = 'center';
                    info.style.gap = '10px';
                    info.style.flex = '1';
                    info.style.minWidth = '240px';

                    const isPrimary = (idx === 0);

                    const nameTag = document.createElement('span');
                    nameTag.style.fontWeight = '700';
                    nameTag.style.fontSize = '12px';
                    nameTag.style.padding = '3px 8px';
                    nameTag.style.borderRadius = '6px';
                    nameTag.style.background = isPrimary ? '#e0f2fe' : '#fef3c7';
                    nameTag.style.color = isPrimary ? '#0369a1' : '#b45309';
                    nameTag.textContent = prov.name;

                    let primaryBadge = null;
                    if (isPrimary) {
                        primaryBadge = document.createElement('span');
                        primaryBadge.style.fontSize = '10px';
                        primaryBadge.style.padding = '2px 6px';
                        primaryBadge.style.borderRadius = '4px';
                        primaryBadge.style.background = '#dbeafe';
                        primaryBadge.style.color = '#1e40af';
                        primaryBadge.style.fontWeight = '700';
                        primaryBadge.style.border = '1px solid #93c5fd';
                        primaryBadge.textContent = '⭐ Primary';
                        primaryBadge.title = 'Current Primary Provider (Position #1)';
                    }

                    const countTag = document.createElement('span');
                    countTag.style.fontSize = '11px';
                    countTag.style.padding = '2px 8px';
                    countTag.style.borderRadius = '10px';
                    countTag.style.background = '#f3f4f6';
                    countTag.style.color = '#4b5563';
                    countTag.style.fontWeight = '600';
                    countTag.textContent = `${(prov.channel_count || 0).toLocaleString()} channels`;

                    const isXtream = (prov.type === 'xtream' || !!prov.server);
                    let xtBadge = null;
                    if (isXtream) {
                        xtBadge = document.createElement('span');
                        xtBadge.style.fontSize = '10px';
                        xtBadge.style.padding = '2px 6px';
                        xtBadge.style.borderRadius = '4px';
                        xtBadge.style.background = '#f3e8ff';
                        xtBadge.style.color = '#7e22ce';
                        xtBadge.style.fontWeight = '700';
                        xtBadge.style.border = '1px solid #d8b4fe';
                        xtBadge.textContent = '⚡ Xtream Codes';
                    }

                    const urlCode = document.createElement('code');
                    urlCode.style.fontSize = '11px';
                    urlCode.style.fontFamily = 'var(--mono)';
                    urlCode.style.color = 'var(--muted)';
                    urlCode.style.maxWidth = '380px';
                    urlCode.style.overflow = 'hidden';
                    urlCode.style.textOverflow = 'ellipsis';
                    urlCode.style.whiteSpace = 'nowrap';
                    const displayUrl = isXtream && prov.server ? `${prov.server} (${prov.username || 'user'}) [${prov.stream_format || 'ts'}]` : (prov.url || '');
                    urlCode.title = displayUrl;
                    urlCode.textContent = displayUrl;

                    info.appendChild(nameTag);
                    if (primaryBadge) info.appendChild(primaryBadge);
                    if (xtBadge) info.appendChild(xtBadge);
                    info.appendChild(countTag);
                    info.appendChild(urlCode);

                    const actions = document.createElement('div');
                    actions.style.display = 'flex';
                    actions.style.alignItems = 'center';
                    actions.style.gap = '6px';

                    if (!isPrimary) {
                        const primaryBtn = document.createElement('button');
                        primaryBtn.type = 'button';
                        primaryBtn.className = 'btn btn-secondary';
                        primaryBtn.style.padding = '4px 10px';
                        primaryBtn.style.fontSize = '11px';
                        primaryBtn.style.background = '#f0fdf4';
                        primaryBtn.style.color = '#15803d';
                        primaryBtn.style.border = '1px solid #bbf7d0';
                        primaryBtn.style.borderRadius = '6px';
                        primaryBtn.style.cursor = 'pointer';
                        primaryBtn.style.fontWeight = '600';
                        primaryBtn.textContent = '⭐ Set Primary';
                        primaryBtn.title = `Promote ${prov.name} to Primary Provider (#1)`;
                        primaryBtn.onclick = () => setPrimaryProvider(prov.name);
                        actions.appendChild(primaryBtn);
                    }

                    const listBtn = document.createElement('button');
                    listBtn.type = 'button';
                    listBtn.className = 'btn btn-secondary';
                    listBtn.style.padding = '4px 10px';
                    listBtn.style.fontSize = '11px';
                    listBtn.style.background = '#eff6ff';
                    listBtn.style.color = '#1d4ed8';
                    listBtn.style.border = '1px solid #bfdbfe';
                    listBtn.style.borderRadius = '6px';
                    listBtn.style.cursor = 'pointer';
                    listBtn.style.fontWeight = '600';
                    listBtn.textContent = '📋 Channels';
                    listBtn.title = `Browse all channels for ${prov.name}`;
                    listBtn.onclick = () => openProviderChannels(prov.name, prov.channel_count || 0);

                    const syncBtn = document.createElement('button');
                    syncBtn.type = 'button';
                    syncBtn.className = 'btn btn-secondary';
                    syncBtn.style.padding = '4px 10px';
                    syncBtn.style.fontSize = '11px';
                    syncBtn.textContent = '🔄 Sync';
                    syncBtn.title = `Fetch latest M3U & update database for ${prov.name}`;
                    syncBtn.onclick = () => syncSingleProvider(prov.name, syncBtn);

                    const editBtn = document.createElement('button');
                    editBtn.type = 'button';
                    editBtn.className = 'btn btn-secondary';
                    editBtn.style.padding = '4px 10px';
                    editBtn.style.fontSize = '11px';
                    editBtn.style.background = '#fef3c7';
                    editBtn.style.color = '#b45309';
                    editBtn.style.border = '1px solid #fde68a';
                    editBtn.style.borderRadius = '6px';
                    editBtn.style.cursor = 'pointer';
                    editBtn.style.fontWeight = '600';
                    editBtn.textContent = '✏️ Edit';
                    editBtn.title = `Edit configuration for ${prov.name}`;
                    editBtn.onclick = () => openEditProviderModal(prov);

                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.className = 'btn btn-secondary';
                    removeBtn.style.padding = '4px 10px';
                    removeBtn.style.fontSize = '11px';
                    removeBtn.style.background = '#fef2f2';
                    removeBtn.style.color = '#dc2626';
                    removeBtn.style.border = '1px solid #fecaca';
                    removeBtn.style.borderRadius = '6px';
                    removeBtn.style.cursor = 'pointer';
                    removeBtn.style.fontWeight = '600';
                    removeBtn.textContent = '🗑️ Delete';
                    removeBtn.title = `Delete ${prov.name} and remove its channels from database`;
                    removeBtn.onclick = () => removeProvider(prov.name, prov.channel_count || 0);

                    actions.appendChild(listBtn);
                    actions.appendChild(editBtn);
                    actions.appendChild(syncBtn);
                    actions.appendChild(removeBtn);

                    row.appendChild(info);
                    row.appendChild(actions);
                    container.appendChild(row);
                });
            } catch (e) {
                console.error("Error loading provider config:", e);
            }
        }

        function switchProviderTab(tab) {
            const m3uBtn = document.getElementById('tab-prov-m3u');
            const xtreamBtn = document.getElementById('tab-prov-xtream');
            const m3uPanel = document.getElementById('panel-prov-m3u');
            const xtreamPanel = document.getElementById('panel-prov-xtream');

            if (tab === 'xtream') {
                if (m3uBtn) { m3uBtn.style.background = 'transparent'; m3uBtn.style.color = 'var(--muted)'; m3uBtn.style.boxShadow = 'none'; }
                if (xtreamBtn) { xtreamBtn.style.background = '#ffffff'; xtreamBtn.style.color = '#7c3aed'; xtreamBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)'; }
                if (m3uPanel) m3uPanel.style.display = 'none';
                if (xtreamPanel) xtreamPanel.style.display = 'block';
            } else {
                if (m3uBtn) { m3uBtn.style.background = '#ffffff'; m3uBtn.style.color = 'var(--ink)'; m3uBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)'; }
                if (xtreamBtn) { xtreamBtn.style.background = 'transparent'; xtreamBtn.style.color = 'var(--muted)'; xtreamBtn.style.boxShadow = 'none'; }
                if (m3uPanel) m3uPanel.style.display = 'block';
                if (xtreamPanel) xtreamPanel.style.display = 'none';
            }
        }

        async function addXtreamProvider() {
            const nameInput = document.getElementById('xtream-provider-name');
            const serverInput = document.getElementById('xtream-provider-server');
            const userInput = document.getElementById('xtream-provider-username');
            const passInput = document.getElementById('xtream-provider-password');
            const formatSelect = document.getElementById('xtream-provider-format');
            const fetchCheck = document.getElementById('xtream-provider-fetch');
            const btn = document.getElementById('btn-add-xtream-provider');

            const name = (nameInput?.value || '').trim();
            const server = (serverInput?.value || '').trim();
            const username = (userInput?.value || '').trim();
            const password = (passInput?.value || '').trim();
            const streamFormat = formatSelect ? formatSelect.value : 'ts';
            const fetchNow = fetchCheck ? fetchCheck.checked : true;

            if (!server || !username || !password) {
                alert('Please enter Server URL, Username, and Password for Xtream Codes API.');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = fetchNow ? '⏳ Connecting & starting sync...' : '⏳ Adding...';
            }

            try {
                const res = await fetch(getApiUrl('api/providers/add'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        type: 'xtream',
                        server: server,
                        username: username,
                        password: password,
                        stream_format: streamFormat,
                        fetch_now: fetchNow
                    })
                });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    showToast(data.message || 'Xtream provider added successfully!');
                    if (nameInput) nameInput.value = '';
                    if (serverInput) serverInput.value = '';
                    if (userInput) userInput.value = '';
                    if (passInput) passInput.value = '';
                    await loadProviderConfig();
                    if (fetchNow) {
                        btn.textContent = '⏳ Ingesting streams...';
                        pollRefreshStatus(
                            (progress) => {
                                btn.textContent = `⏳ ${progress}`;
                            },
                            async (resData) => {
                                showToast(resData.message || 'Xtream streams ingested successfully!');
                                btn.disabled = false;
                                btn.textContent = '⚡ Add Xtream Provider';
                                await loadProviderConfig();
                                if (typeof loadIptvCategories === 'function') loadIptvCategories();
                            },
                            (err) => {
                                showToast('Ingestion notice: ' + err);
                                btn.disabled = false;
                                btn.textContent = '⚡ Add Xtream Provider';
                                loadProviderConfig();
                            }
                        );
                    } else {
                        btn.disabled = false;
                        btn.textContent = '⚡ Add Xtream Provider';
                    }
                } else {
                    alert('Error adding Xtream provider: ' + ((data && data.error) || 'Unknown error'));
                    btn.disabled = false;
                    btn.textContent = '⚡ Add Xtream Provider';
                }
            } catch (e) {
                alert('Error adding Xtream provider: ' + e);
                btn.disabled = false;
                btn.textContent = '⚡ Add Xtream Provider';
            }
        }

        async function addNewProvider() {
            const nameInput = document.getElementById('new-provider-name');
            const urlInput = document.getElementById('new-provider-url');
            const fetchCheck = document.getElementById('new-provider-fetch');
            const btn = document.getElementById('btn-add-provider');

            const name = (nameInput?.value || '').trim();
            const url = (urlInput?.value || '').trim();
            const fetchNow = fetchCheck ? fetchCheck.checked : true;

            if (!url) {
                alert('Please enter a valid M3U playlist URL.');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = fetchNow ? '⏳ Connecting & starting sync...' : '⏳ Adding...';
            }

            try {
                const res = await fetch(getApiUrl('api/providers/add'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, url: url, fetch_now: fetchNow })
                });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    showToast(data.message || 'Provider added successfully!');
                    if (nameInput) nameInput.value = '';
                    if (urlInput) urlInput.value = '';
                    await loadProviderConfig();
                    if (fetchNow) {
                        btn.textContent = '⏳ Ingesting channels...';
                        pollRefreshStatus(
                            (progress) => {
                                btn.textContent = `⏳ ${progress}`;
                            },
                            async (resData) => {
                                showToast(resData.message || 'M3U channels ingested successfully!');
                                btn.disabled = false;
                                btn.textContent = '+ Add Provider';
                                await loadProviderConfig();
                                if (typeof loadIptvCategories === 'function') loadIptvCategories();
                            },
                            (err) => {
                                showToast('Ingestion notice: ' + err);
                                btn.disabled = false;
                                btn.textContent = '+ Add Provider';
                                loadProviderConfig();
                            }
                        );
                    } else {
                        btn.disabled = false;
                        btn.textContent = '+ Add Provider';
                    }
                } else {
                    alert('Error adding provider: ' + ((data && data.error) || 'Unknown error'));
                    btn.disabled = false;
                    btn.textContent = '+ Add Provider';
                }
            } catch (e) {
                alert('Error adding provider: ' + e);
                btn.disabled = false;
                btn.textContent = '+ Add Provider';
            }
        }

        async function setPrimaryProvider(provName) {
            try {
                const res = await fetch(getApiUrl('api/providers/set-primary'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: provName })
                });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    showToast(data.message || `Set "${provName}" as Primary Provider`);
                    await loadProviderConfig();
                } else {
                    alert('Error setting primary provider: ' + ((data && data.error) || 'Unknown error'));
                }
            } catch (e) {
                alert('Error setting primary provider: ' + e);
            }
        }

        async function removeProvider(provName, channelCount) {
            const countMsg = channelCount > 0 ? ` and delete its ${channelCount.toLocaleString()} channels from the shared database` : '';
            if (!confirm(`Are you sure you want to remove provider "${provName}"${countMsg}?`)) {
                return;
            }

            try {
                const res = await fetch(getApiUrl('api/providers/remove'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: provName })
                });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    showToast(data.message || `Removed provider "${provName}"`);
                    await loadProviderConfig();
                    const select = document.getElementById('iptv-category-select');
                    if (select) {
                        select.innerHTML = '<option value="">📂 Browse Category...</option>';
                    }
                    if (typeof loadIptvCategories === 'function') {
                        loadIptvCategories();
                    }
                    const searchResults = document.getElementById('iptv-search-results');
                    if (searchResults) {
                        searchResults.innerHTML = '';
                    }
                } else {
                    alert('Error removing provider: ' + ((data && data.error) || 'Unknown error'));
                }
            } catch (e) {
                alert('Error removing provider: ' + e);
            }
        }

        let currentEditProvType = 'm3u';

        function switchEditProviderType(type) {
            currentEditProvType = type;
            const m3uBtn = document.getElementById('tab-edit-prov-m3u');
            const xtreamBtn = document.getElementById('tab-edit-prov-xtream');
            const m3uPanel = document.getElementById('panel-edit-prov-m3u');
            const xtreamPanel = document.getElementById('panel-edit-prov-xtream');

            if (type === 'xtream') {
                if (m3uBtn) { m3uBtn.style.background = 'transparent'; m3uBtn.style.color = 'var(--muted)'; m3uBtn.style.boxShadow = 'none'; }
                if (xtreamBtn) { xtreamBtn.style.background = '#ffffff'; xtreamBtn.style.color = '#7c3aed'; xtreamBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)'; }
                if (m3uPanel) m3uPanel.style.display = 'none';
                if (xtreamPanel) xtreamPanel.style.display = 'block';
            } else {
                if (m3uBtn) { m3uBtn.style.background = '#ffffff'; m3uBtn.style.color = 'var(--ink)'; m3uBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)'; }
                if (xtreamBtn) { xtreamBtn.style.background = 'transparent'; xtreamBtn.style.color = 'var(--muted)'; xtreamBtn.style.boxShadow = 'none'; }
                if (m3uPanel) m3uPanel.style.display = 'block';
                if (xtreamPanel) xtreamPanel.style.display = 'none';
            }
        }

        function openEditProviderModal(prov) {
            if (!prov) return;
            const modal = document.getElementById('provider-edit-modal');
            if (!modal) return;

            document.getElementById('edit-prov-orig-name').value = prov.name || '';
            document.getElementById('edit-prov-name').value = prov.name || '';
            document.getElementById('edit-prov-modal-title').textContent = `✏️ Edit IPTV Provider: ${prov.name || ''}`;

            const provType = (prov.type || 'm3u').toLowerCase();
            document.getElementById('edit-prov-url').value = prov.url || '';
            document.getElementById('edit-prov-server').value = prov.server || '';
            document.getElementById('edit-prov-username').value = prov.username || '';
            // The server never sends provider passwords; leaving this blank keeps the stored one
            document.getElementById('edit-prov-password').value = '';
            document.getElementById('edit-prov-format').value = prov.stream_format || 'ts';
            document.getElementById('edit-prov-fetch-now').checked = false;

            switchEditProviderType(provType === 'xtream' ? 'xtream' : 'm3u');
            modal.classList.add('active');
        }

        function closeEditProviderModal() {
            const modal = document.getElementById('provider-edit-modal');
            if (modal) modal.classList.remove('active');
        }

        async function submitEditProvider() {
            const origName = (document.getElementById('edit-prov-orig-name')?.value || '').trim();
            const name = (document.getElementById('edit-prov-name')?.value || '').trim();
            const fetchNow = document.getElementById('edit-prov-fetch-now')?.checked || false;
            const btn = document.getElementById('btn-save-edit-provider');

            if (!name) {
                alert('Provider name cannot be empty.');
                return;
            }

            const payload = {
                orig_name: origName,
                name: name,
                type: currentEditProvType,
                fetch_now: fetchNow
            };

            if (currentEditProvType === 'xtream') {
                payload.server = (document.getElementById('edit-prov-server')?.value || '').trim();
                payload.username = (document.getElementById('edit-prov-username')?.value || '').trim();
                payload.password = (document.getElementById('edit-prov-password')?.value || '').trim();
                payload.stream_format = document.getElementById('edit-prov-format')?.value || 'ts';

                if (!payload.server || !payload.username) {
                    alert('Server URL and Username are required for Xtream provider (leave Password blank to keep the current one).');
                    return;
                }
            } else {
                payload.url = (document.getElementById('edit-prov-url')?.value || '').trim();
                if (!payload.url) {
                    alert('Please enter a valid M3U playlist URL or file path.');
                    return;
                }
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ Saving...';
            }

            try {
                const res = await fetch(getApiUrl('api/providers/update'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    showToast(data.message || 'Provider updated successfully!');
                    closeEditProviderModal();
                    await loadProviderConfig();
                    if (typeof loadIptvCategories === 'function') loadIptvCategories();

                    if (fetchNow) {
                        showToast(`Syncing channels for "${name}"...`);
                        pollRefreshStatus(
                            null,
                            async (resData) => {
                                showToast(resData.message || `Provider "${name}" synced!`);
                                await loadProviderConfig();
                                if (typeof loadIptvCategories === 'function') loadIptvCategories();
                            },
                            (err) => {
                                alert('Notice while syncing provider: ' + err);
                                loadProviderConfig();
                            }
                        );
                    }
                } else {
                    alert('Error updating provider: ' + ((data && data.error) || 'Unknown error'));
                }
            } catch (e) {
                alert('Error updating provider: ' + e.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '💾 Save Changes';
                }
            }
        }

        async function syncSingleProvider(provName, btn) {
            if (btn) {
                btn.disabled = true;
                btn.dataset.orig = btn.innerHTML;
                btn.innerHTML = '⏳ Syncing...';
            }

            try {
                const res = await fetch(getApiUrl('api/provider/refresh-db'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: provName })
                });
                const data = await safeParseJson(res);
                if (!data || !data.success) {
                    alert('Error syncing provider: ' + ((data && data.error) || 'Failed to start sync'));
                    if (btn) {
                        btn.disabled = false;
                        if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
                    }
                    return;
                }

                if (data.status === 'completed') {
                    showToast(data.message || `Provider "${provName}" synced!`);
                    await loadProviderConfig();
                    if (typeof loadIptvCategories === 'function') loadIptvCategories();
                    if (btn) {
                        btn.disabled = false;
                        if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
                    }
                    return;
                }

                pollRefreshStatus(
                    (progressText) => {
                        if (btn) btn.innerHTML = `⏳ ${progressText}`;
                    },
                    async (completedData) => {
                        showToast(completedData.message || `Provider "${provName}" synced!`);
                        await loadProviderConfig();
                        if (typeof loadIptvCategories === 'function') loadIptvCategories();
                        if (btn) {
                            btn.disabled = false;
                            if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
                        }
                    },
                    (errorMessage) => {
                        alert('Error syncing provider: ' + errorMessage);
                        if (btn) {
                            btn.disabled = false;
                            if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
                        }
                    }
                );
            } catch (e) {
                alert('Error syncing provider: ' + e.message);
                if (btn) {
                    btn.disabled = false;
                    if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
                }
            }
        }

        async function resetProviderConfig() {
            if (!confirm("Are you sure you want to reset to default IPTV provider and delete custom provider channels from shared database?")) return;
            try {
                const res = await fetch(getApiUrl('api/provider/reset'), { method: 'POST' });
                const data = await safeParseJson(res);
                if (data && data.success) {
                    showToast('Provider Reset to Default');
                    await loadProviderConfig();
                    if (typeof loadIptvCategories === 'function') {
                        loadIptvCategories();
                    }
                } else {
                    alert('Error resetting provider: ' + ((data && data.error) || 'Unknown error'));
                }
            } catch (e) {
                alert('Error resetting provider: ' + e.message);
            }
        }

        async function refreshProviderDatabase() {
            const btns = document.querySelectorAll('.btn-refresh-iptv');
            btns.forEach(btn => {
                btn.dataset.orig = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = '⏳ Starting refresh...';
                btn.style.opacity = '0.75';
            });

            function finishRefreshUi() {
                btns.forEach(btn => {
                    btn.disabled = false;
                    if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
                    btn.style.opacity = '1';
                });
            }

            try {
                const res = await fetch(getApiUrl('api/provider/refresh-db'), { method: 'POST' });
                const data = await safeParseJson(res);

                if (!data || !data.success) {
                    alert('Error refreshing IPTV database: ' + ((data && data.error) || 'Failed to start refresh'));
                    finishRefreshUi();
                    return;
                }

                if (data.status === 'completed') {
                    showToast(data.message || `Database refreshed with ${data.total_channels} channels!`);
                    finishRefreshUi();
                    setTimeout(() => { location.reload(); }, 1200);
                    return;
                }

                pollRefreshStatus(
                    (progressText) => {
                        btns.forEach(btn => {
                            btn.innerHTML = `⏳ ${progressText}`;
                        });
                    },
                    (completedData) => {
                        showToast(completedData.message || `Database refreshed with ${completedData.total_channels} channels!`);
                        const select = document.getElementById('iptv-category-select');
                        if (select) {
                            select.innerHTML = '<option value="">📂 Browse Category...</option>';
                        }
                        if (typeof loadIptvCategories === 'function') {
                            loadIptvCategories();
                        }
                        finishRefreshUi();
                        setTimeout(() => { location.reload(); }, 1200);
                    },
                    (errorMessage) => {
                        alert('Error refreshing IPTV database: ' + errorMessage);
                        finishRefreshUi();
                    }
                );
            } catch (e) {
                alert('Error refreshing IPTV database: ' + e.message);
                finishRefreshUi();
            }
        }

        let selectedM3UFiles = [];

        async function openUploadM3UModal() {
            const modal = document.getElementById('upload-m3u-modal');
            if (modal) modal.classList.add('active');

            clearSelectedM3UFiles();
            const statusBox = document.getElementById('upload-m3u-status-box');
            if (statusBox) {
                statusBox.style.display = 'none';
                statusBox.innerHTML = '';
            }

            const sepRadio = document.getElementById('upload-mode-separate');
            if (sepRadio) sepRadio.checked = true;
            onUploadModeChange();

            try {
                const res = await fetch(getApiUrl('api/providers'));
                const data = await res.json();
                const datalist = document.getElementById('provider-name-datalist');
                if (datalist && data.providers) {
                    datalist.innerHTML = '';
                    data.providers.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.name;
                        datalist.appendChild(opt);
                    });
                }
            } catch (err) {
                console.warn('Failed to load existing providers for datalist:', err);
            }

            setupM3UDropzone();
        }

        function closeUploadM3UModal() {
            const modal = document.getElementById('upload-m3u-modal');
            if (modal) modal.classList.remove('active');
        }

        function onUploadModeChange() {
            const mode = document.querySelector('input[name="upload-provider-mode"]:checked')?.value || 'separate';
            const nameContainer = document.getElementById('upload-provider-name-container');
            const provInput = document.getElementById('upload-provider-name');

            if (mode === 'merged') {
                if (nameContainer) nameContainer.style.display = 'block';
                if (provInput && !provInput.value.trim() && selectedM3UFiles.length > 0) {
                    let stem = selectedM3UFiles[0].name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
                    provInput.value = stem.replace(/\b\w/g, l => l.toUpperCase());
                }
            } else {
                if (nameContainer) nameContainer.style.display = 'none';
            }
            updateSubmitM3UButton();
        }

        function setupM3UDropzone() {
            const dropzone = document.getElementById('upload-m3u-dropzone');
            if (!dropzone || dropzone._dndInitialized) return;
            dropzone._dndInitialized = true;

            ['dragenter', 'dragover'].forEach(eventName => {
                dropzone.addEventListener(eventName, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.style.background = '#dbeafe';
                    dropzone.style.borderColor = '#2563eb';
                }, false);
            });

            ['dragleave', 'drop'].forEach(eventName => {
                dropzone.addEventListener(eventName, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.style.background = '#eff6ff';
                    dropzone.style.borderColor = '#3b82f6';
                }, false);
            });

            dropzone.addEventListener('drop', (e) => {
                const dt = e.dataTransfer;
                if (dt.files && dt.files.length > 0) {
                    addM3UFiles(Array.from(dt.files));
                }
            }, false);
        }

        function handleM3UFilesSelected(event) {
            const files = event.target.files;
            if (files && files.length > 0) {
                addM3UFiles(Array.from(files));
            }
        }

        function addM3UFiles(files) {
            const validFiles = files.filter(f => {
                const name = f.name.toLowerCase();
                return name.endsWith('.m3u') || name.endsWith('.m3u8') || name.endsWith('.txt');
            });

            if (validFiles.length === 0) {
                alert('Please select valid .m3u or .m3u8 playlist files.');
                return;
            }

            validFiles.forEach(newFile => {
                if (!selectedM3UFiles.some(f => f.name === newFile.name && f.size === newFile.size)) {
                    selectedM3UFiles.push(newFile);
                }
            });

            renderSelectedM3UFiles();
            onUploadModeChange();
        }

        function removeSelectedM3UFile(idx) {
            selectedM3UFiles.splice(idx, 1);
            renderSelectedM3UFiles();
            onUploadModeChange();
        }

        function clearSelectedM3UFiles() {
            selectedM3UFiles = [];
            const fileInput = document.getElementById('upload-m3u-file-input');
            if (fileInput) fileInput.value = '';
            const provInput = document.getElementById('upload-provider-name');
            if (provInput) provInput.value = '';
            renderSelectedM3UFiles();
            updateSubmitM3UButton();
        }

        function renderSelectedM3UFiles() {
            const container = document.getElementById('upload-m3u-files-container');
            const listEl = document.getElementById('upload-m3u-files-list');
            const summaryEl = document.getElementById('upload-m3u-files-summary');

            if (!container || !listEl || !summaryEl) return;

            if (selectedM3UFiles.length === 0) {
                container.style.display = 'none';
                listEl.innerHTML = '';
                updateSubmitM3UButton();
                return;
            }

            container.style.display = 'block';
            let totalBytes = 0;
            selectedM3UFiles.forEach(f => totalBytes += f.size);
            const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
            summaryEl.innerHTML = `📁 <strong>${selectedM3UFiles.length}</strong> file(s) selected (Total: <strong>${totalMb} MB</strong>)`;

            listEl.innerHTML = '';
            selectedM3UFiles.forEach((file, index) => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.alignItems = 'center';
                item.style.justifyContent = 'space-between';
                item.style.background = '#ffffff';
                item.style.border = '1px solid var(--line)';
                item.style.borderRadius = '6px';
                item.style.padding = '6px 10px';

                const mb = (file.size / (1024 * 1024)).toFixed(2);
                item.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
                        <span style="font-size: 14px;">📄</span>
                        <span style="font-size: 12px; font-weight: 600; color: #1f2937; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${file.name}</span>
                        <span style="font-size: 11px; color: var(--muted); background: #f3f4f6; padding: 1px 6px; border-radius: 4px;">${mb} MB</span>
                    </div>
                    <button type="button" class="btn btn-secondary" onclick="removeSelectedM3UFile(${index})" style="padding: 2px 6px; font-size: 11px; border: none; background: transparent; color: #dc2626; cursor: pointer;" title="Remove this file">✕</button>
                `;
                listEl.appendChild(item);
            });

            updateSubmitM3UButton();
        }

        function updateSubmitM3UButton() {
            const submitBtn = document.getElementById('btn-submit-m3u-upload');
            if (!submitBtn) return;
            const count = selectedM3UFiles.length;
            if (count === 0) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '🚀 Upload & Ingest Channels';
            } else {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `🚀 Upload & Ingest (${count} ${count === 1 ? 'File' : 'Files'})`;
            }
        }

        async function submitM3UUpload() {
            if (selectedM3UFiles.length === 0) {
                alert('Please select at least one M3U file to upload.');
                return;
            }

            const mode = document.querySelector('input[name="upload-provider-mode"]:checked')?.value || 'separate';
            const provInput = document.getElementById('upload-provider-name');
            const providerName = (provInput ? provInput.value : '').trim();

            if (mode === 'merged' && !providerName) {
                alert('Please enter a target provider name for the merged playlist.');
                if (provInput) provInput.focus();
                return;
            }

            const submitBtn = document.getElementById('btn-submit-m3u-upload');
            const statusBox = document.getElementById('upload-m3u-status-box');

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '⏳ Uploading & Ingesting...';
            }

            if (statusBox) {
                statusBox.style.display = 'block';
                statusBox.style.background = '#eff6ff';
                statusBox.style.border = '1px solid #bfdbfe';
                statusBox.style.color = '#1e40af';
                statusBox.innerHTML = `<strong>Processing ${selectedM3UFiles.length} file(s)...</strong><br>Uploading files, parsing streams, and indexing database. Please wait...`;
            }

            const formData = new FormData();
            selectedM3UFiles.forEach(file => {
                formData.append('files', file);
            });
            formData.append('mode', mode);
            if (providerName) {
                formData.append('provider_name', providerName);
            }

            try {
                const res = await fetch(getApiUrl('api/provider/upload-m3u'), {
                    method: 'POST',
                    body: formData
                });
                const data = await safeParseJson(res);

                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Failed to upload M3U files');
                }

                if (statusBox) {
                    statusBox.style.background = '#ecfdf5';
                    statusBox.style.border = '1px solid #a7f3d0';
                    statusBox.style.color = '#065f46';
                    
                    let detailsHtml = '';
                    if (data.results && data.results.length > 0) {
                        detailsHtml = '<ul style="margin: 6px 0 0 16px; padding: 0;">';
                        data.results.forEach(r => {
                            detailsHtml += `<li><strong>${r.provider}</strong>: ${r.channels.toLocaleString()} channels</li>`;
                        });
                        detailsHtml += '</ul>';
                    }

                    statusBox.innerHTML = `✅ <strong>Success!</strong> ${data.message}${detailsHtml}`;
                }

                showToast(`Imported ${data.total_channels ? data.total_channels.toLocaleString() : 0} channels across ${data.results?.length || 1} provider(s)!`);
                await loadProviderConfig();
                if (typeof loadIptvCategories === 'function') {
                    loadIptvCategories();
                }

                if (submitBtn) {
                    submitBtn.innerHTML = '✅ Ingestion Complete';
                }

                setTimeout(() => {
                    closeUploadM3UModal();
                }, 2500);
            } catch (err) {
                if (statusBox) {
                    statusBox.style.display = 'block';
                    statusBox.style.background = '#fef2f2';
                    statusBox.style.border = '1px solid #fecaca';
                    statusBox.style.color = '#991b1b';
                    statusBox.innerHTML = `❌ <strong>Upload Failed:</strong> ${err.message}`;
                }
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '🚀 Retry Upload';
                }
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadProviderConfig();
        });

        // Track form edits
        window.addEventListener('input', (e) => {
            if (e.target.closest('.stream-item') || e.target.closest('.global-settings')) {
                isFormModified = true;
            }
        });

        let iptvSearchTimeout = null;

        function onIptvSearchInput(val, immediate = false) {
            if (iptvSearchTimeout) clearTimeout(iptvSearchTimeout);
            
            const catSelect = document.getElementById('iptv-category-select');
            if (catSelect) catSelect.value = '';
            
            const query = val.trim();
            const resultsContainer = document.getElementById('iptv-search-results');
            const vBtn = document.getElementById('iptv-search-verify-btn');
            if (query.length < 2) {
                resultsContainer.innerHTML = '';
                window.currentIptvSearchResults = [];
                if (vBtn) vBtn.style.display = 'none';
                sessionStorage.removeItem('iptv_provider_search_state');
                return;
            }

            sessionStorage.setItem('iptv_provider_search_state', JSON.stringify({ type: 'query', val: query }));
            resultsContainer.innerHTML = '<div style="color: var(--text-secondary); padding: 15px; font-size: 13px; text-align: center;">🔍 Searching 1.8M channels database...</div>';
            
            const doSearch = async () => {
                try {
                    const res = await fetch(getApiUrl(`api/channels/search?q=${encodeURIComponent(query)}`));
                    const data = await safeParseJson(res);
                    
                    resultsContainer.innerHTML = '';
                    if (!Array.isArray(data)) {
                        console.error("Search API error:", data);
                        window.currentIptvSearchResults = [];
                        if (vBtn) vBtn.style.display = 'none';
                        const errDiv = document.createElement('div');
                        errDiv.style.color = 'var(--danger-color)';
                        errDiv.style.fontSize = '13px';
                        errDiv.style.padding = '10px';
                        errDiv.style.textAlign = 'center';
                        errDiv.textContent = `Error: ${data.error || 'Invalid API response'}`;
                        resultsContainer.appendChild(errDiv);
                        return;
                    }
                    if (data.length === 0) {
                        window.currentIptvSearchResults = [];
                        if (vBtn) vBtn.style.display = 'none';
                        const noResults = document.createElement('div');
                        noResults.style.color = 'var(--text-secondary)';
                        noResults.style.fontSize = '13px';
                        noResults.style.padding = '10px';
                        noResults.style.textAlign = 'center';
                        noResults.textContent = 'No channels found';
                        resultsContainer.appendChild(noResults);
                        return;
                    }
                    
                    const fragment = document.createDocumentFragment();
                    const displayData = data.slice(0, 100);
                    window.currentIptvSearchResults = displayData;
                    if (vBtn) {
                        vBtn.style.display = 'inline-flex';
                        vBtn.innerHTML = `⚡ Verify Visible (${displayData.length})`;
                    }
                    displayData.forEach(ch => {
                        const item = document.createElement('div');
                        item.style.display = 'flex';
                        item.style.justifyContent = 'space-between';
                        item.style.alignItems = 'center';
                        item.style.padding = '10px 14px';
                        item.style.background = '#ffffff';
                        item.style.border = '1px solid var(--line)';
                        item.style.borderRadius = '10px';
                        item.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                        item.style.fontSize = '13px';
                        item.style.color = 'var(--ink)';
                        
                        const label = document.createElement('div');
                        label.style.display = 'flex';
                        label.style.alignItems = 'center';
                        label.style.gap = '8px';
                        label.style.flexWrap = 'wrap';
                        label.style.fontWeight = '600';
                        label.style.flex = '1';
                        label.style.minWidth = '220px';

                        let labelText = escapeHtml(ch.name || 'Unnamed Channel');
                        if (ch.provider) {
                            labelText += ` <span style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">🏷️ ${escapeHtml(ch.provider)}</span>`;
                        }
                        if (ch.live_title) {
                            labelText += ` <span style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">🔴 Live: ${escapeHtml(ch.live_title)}</span>`;
                        }
                        if (ch.category) {
                            labelText += ` <span style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">${escapeHtml(ch.category)}</span>`;
                        }
                        
                        const textSpan = document.createElement('span');
                        textSpan.innerHTML = labelText;
                        label.appendChild(textSpan);

                        const statusBadge = document.createElement('span');
                        if (ch.id) statusBadge.id = `iptv-search-status-${ch.id}`;
                        statusBadge.style.display = 'inline-flex';
                        statusBadge.style.alignItems = 'center';
                        statusBadge.innerHTML = renderChannelStatusBadge(ch);
                        label.appendChild(statusBadge);
                        
                        const btnContainer = document.createElement('div');
                        btnContainer.style.display = 'flex';
                        btnContainer.style.gap = '8px';
                        btnContainer.style.alignItems = 'center';
                        btnContainer.style.flexShrink = '0';

                        const verifyBtn = document.createElement('button');
                        verifyBtn.className = 'btn btn-secondary';
                        verifyBtn.style.padding = '6px 12px';
                        verifyBtn.style.fontSize = '12px';
                        verifyBtn.textContent = '⚡ Verify';
                        verifyBtn.title = 'Verify stream playability & latency';
                        verifyBtn.onclick = (e) => {
                            e.stopPropagation();
                            verifyIptvSearchChannel(ch, verifyBtn, statusBadge);
                        };

                        const testBtn = document.createElement('button');
                        testBtn.className = 'btn btn-secondary';
                        testBtn.style.padding = '6px 12px';
                        testBtn.style.fontSize = '12px';
                        testBtn.textContent = '🔗 Test';
                        testBtn.title = 'Test stream in embedded preview';
                        testBtn.onclick = (e) => {
                            e.stopPropagation();
                            testCardStream(ch.url, ch.name || '');
                        };

                        const isAlreadyAdded = (playlistData && Array.isArray(playlistData.streams) && playlistData.streams.some(s => s && s.url === ch.url));
                        const btn = document.createElement('button');
                        btn.className = 'btn btn-secondary';
                        btn.style.padding = '6px 12px';
                        btn.style.fontSize = '12px';
                        if (isAlreadyAdded) {
                            btn.textContent = '✓ In Playlist';
                            btn.style.background = '#dcfce7';
                            btn.style.color = '#15803d';
                            btn.style.borderColor = '#86efac';
                        } else {
                            btn.textContent = '+ Add to Playlist';
                        }
                        btn.onclick = () => {
                            const isYt = (ch.url && (ch.url.includes('youtube.com') || ch.url.includes('youtu.be')));
                            const newStream = {
                                url: ch.url,
                                type: isYt ? 'youtube_embed' : 'generic'
                            };
                            if (ch.name) newStream.name = ch.name;
                            if (ch.category) newStream.category = ch.category;
                            
                            playlistData.streams.push(newStream);
                            isFormModified = true;
                            renderCategorizedGrid();
                            
                            sessionStorage.setItem('iptv_restore_search_on_load', 'true');
                            
                            btn.style.background = '#dcfce7';
                            btn.style.borderColor = '#86efac';
                            btn.style.color = '#15803d';
                            btn.textContent = 'Added! ✓';
                            setTimeout(() => {
                                btn.textContent = '✓ In Playlist';
                            }, 1500);
                        };
                        
                        btnContainer.appendChild(verifyBtn);
                        btnContainer.appendChild(testBtn);
                        btnContainer.appendChild(btn);

                        item.appendChild(label);
                        item.appendChild(btnContainer);
                        fragment.appendChild(item);
                    });
                    resultsContainer.appendChild(fragment);

                    if (data.length > 100) {
                        const countNote = document.createElement('div');
                        countNote.style.color = 'var(--text-secondary)';
                        countNote.style.fontSize = '12px';
                        countNote.style.padding = '8px';
                        countNote.style.textAlign = 'center';
                        countNote.textContent = `Showing top 100 of ${data.length} channels. Refine query for more.`;
                        resultsContainer.appendChild(countNote);
                    }
                } catch (err) {
                    console.error("IPTV search failed:", err);
                    resultsContainer.innerHTML = `<div style="color: var(--danger-color); padding: 12px; font-size: 13px; text-align: center;">Error searching channels: ${escapeHtml(err.message)}</div>`;
                }
            };

            if (immediate) {
                doSearch();
            } else {
                iptvSearchTimeout = setTimeout(doSearch, 300);
            }
        }

        let ytSearchTimeout = null;
        function triggerYtSearch(term) {
            const input = document.getElementById('yt-search-input');
            if (input) {
                input.value = term;
                performYouTubeSearch(term);
            }
        }

        function onYouTubeSearchInput(query) {
            if (ytSearchTimeout) clearTimeout(ytSearchTimeout);
            const container = document.getElementById('yt-search-results');
            if (!query || query.trim().length < 2) {
                if (container) container.innerHTML = '';
                return;
            }
            ytSearchTimeout = setTimeout(() => {
                performYouTubeSearch(query);
            }, 400);
        }

        async function performYouTubeSearch(query) {
            const container = document.getElementById('yt-search-results');
            if (!container) return;
            if (!query || query.trim().length < 2) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = '<div style="color: var(--text-muted); padding: 15px; font-size: 13px; text-align: center;">🔍 Searching YouTube Live & Videos...</div>';
            
            try {
                const res = await fetch(getApiUrl(`api/youtube/search?q=${encodeURIComponent(query.trim())}`));
                const results = await res.json();
                if (!results || results.length === 0) {
                    container.innerHTML = `<div style="color: var(--text-muted); padding: 15px; font-size: 13px; text-align: center;">No YouTube streams found for "${query}"</div>`;
                    return;
                }
                
                container.innerHTML = '';
                const grid = document.createElement('div');
                grid.style.display = 'grid';
                grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
                grid.style.gap = '12px';
                
                results.forEach(video => {
                    const card = document.createElement('div');
                    card.style.background = '#ffffff';
                    card.style.border = '1px solid var(--line)';
                    card.style.borderRadius = '10px';
                    card.style.padding = '12px';
                    card.style.display = 'flex';
                    card.style.flexDirection = 'column';
                    card.style.justifyContent = 'space-between';
                    card.style.gap = '10px';
                    card.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                    
                    const liveBadge = video.is_live ? '<span style="background: #dc2626; color: white; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; position: absolute; top: 6px; left: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">🔴 LIVE</span>' : '';
                    
                    card.innerHTML = `
                        <div style="display: flex; gap: 12px; align-items: flex-start;">
                            <div style="position: relative; width: 100px; height: 60px; flex-shrink: 0; border-radius: 6px; overflow: hidden; background: #000;">
                                <img src="${video.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy">
                                ${liveBadge}
                            </div>
                            <div style="flex: 1; min-width: 0;">
                                <div style="font-weight: 700; font-size: 13px; color: var(--ink); line-height: 1.3; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;" title="${video.title.replace(/"/g, '&quot;')}">${video.title}</div>
                                <div style="font-size: 11px; color: var(--muted);">${video.channel}</div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center; border-top: 1px solid var(--line); padding-top: 8px;">
                            <button type="button" class="card-btn" onclick="testCardStream('${video.embed_url}', '${encodeURIComponent(video.title).replace(/'/g, "%27")}')" style="font-size: 11px; padding: 4px 8px;">🔗 Preview</button>
                            <button type="button" class="btn" style="background: #dc2626; color: white; border: none; font-size: 11px; padding: 5px 12px; font-weight: 600; border-radius: 6px; cursor: pointer;" onclick="addYouTubeSearchItem('${video.videoId}', '${encodeURIComponent(video.title).replace(/'/g, "%27")}', '${encodeURIComponent(video.channel).replace(/'/g, "%27")}', this)">➕ Add to Playlist</button>
                        </div>
                    `;
                    grid.appendChild(card);
                });
                container.appendChild(grid);
            } catch (e) {
                container.innerHTML = `<div style="color: #f87171; padding: 15px; font-size: 13px; text-align: center;">Error searching YouTube: ${e}</div>`;
            }
        }

        function addYouTubeSearchItem(videoId, encTitle, encChannel, btn) {
            const title = decodeURIComponent(encTitle);
            const channel = decodeURIComponent(encChannel);
            const embedUrl = `https://www.youtube.com/embed/${videoId}`;
            
            if (!playlistData.streams) playlistData.streams = [];
            if (playlistData.streams.some(s => s.url.includes(videoId))) {
                alert("This YouTube stream is already in your playlist!");
                return;
            }
            
            playlistData.streams.push({
                url: embedUrl,
                name: title || channel,
                category: 'YouTube Live',
                type: 'youtube_embed'
            });
            
            isFormModified = true;
            renderCategorizedGrid();
            showToast();
            
            if (btn) {
                btn.textContent = 'Added! ✓';
                btn.style.background = '#10b981';
                setTimeout(() => {
                    btn.textContent = '➕ Add to Playlist';
                    btn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
                }, 1500);
            }
        }

        let ytTitleTimeout = null;
        async function detectAndFetchYtTitle(url) {
            const nameInput = document.getElementById('yt-quick-name');
            if (!url || !nameInput) return;
            
            if (ytTitleTimeout) clearTimeout(ytTitleTimeout);
            if (url.includes('youtube.com') || url.includes('youtu.be')) {
                ytTitleTimeout = setTimeout(async () => {
                    try {
                        const res = await fetch(getApiUrl(`api/playlist/get-title?url=${encodeURIComponent(url)}`));
                        const data = await res.json();
                        if (data && data.title && (!nameInput.value || nameInput.dataset.autofilled === 'true')) {
                            nameInput.value = data.title;
                            nameInput.dataset.autofilled = 'true';
                        }
                    } catch (e) {
                        console.error("Failed to fetch YouTube title:", e);
                    }
                }, 400);
            }
        }

        function addYouTubeStreamQuick() {
            const urlInput = document.getElementById('yt-quick-url');
            const nameInput = document.getElementById('yt-quick-name');
            const catInput = document.getElementById('yt-quick-cat');
            
            const url = urlInput ? urlInput.value.trim() : '';
            const name = nameInput ? nameInput.value.trim() : '';
            const category = (catInput ? catInput.value.trim() : '') || 'YouTube Live';
            
            if (!url) {
                alert("Please paste a YouTube URL");
                return;
            }
            if (!isValidUrl(url)) {
                alert("Invalid URL format. Must start with http:// or https://");
                return;
            }
            
            const newStream = {
                url: url,
                name: name || 'YouTube Stream',
                category: category,
                type: 'youtube_embed'
            };
            
            playlistData.streams.push(newStream);
            isFormModified = true;
            renderCategorizedGrid();
            showToast(`Added "${newStream.name}" to playlist!`);
            
            if (urlInput) urlInput.value = '';
            if (nameInput) {
                nameInput.value = '';
                nameInput.dataset.autofilled = 'false';
            }
        }

        function quickAddYtPreset(name, url, category) {
            const newStream = {
                url: url,
                name: name,
                category: category || 'YouTube Live',
                type: 'youtube_embed'
            };
            
            playlistData.streams.push(newStream);
            isFormModified = true;
            renderCategorizedGrid();
            showToast(`Added Preset: "${name}"`);
        }

        async function loadIptvCategories() {
            const select = document.getElementById('iptv-category-select');
            if (!select) return [];
            
            try {
                const res = await fetch(getApiUrl('api/categories'));
                const categories = await safeParseJson(res);
                if (!Array.isArray(categories)) {
                    console.error("Invalid categories response:", categories);
                    return [];
                }
                
                select.innerHTML = '<option value="">📂 Browse Category...</option>';
                categories.forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.textContent = cat;
                    select.appendChild(opt);
                });
                return categories;
            } catch (err) {
                console.error("Failed to load categories:", err);
                return [];
            }
        }

        async function onIptvCategorySelect(cat) {
            const resultsContainer = document.getElementById('iptv-search-results');
            if (!resultsContainer) return;
            
            const vBtn = document.getElementById('iptv-search-verify-btn');
            if (!cat) {
                resultsContainer.innerHTML = '';
                window.currentIptvSearchResults = [];
                if (vBtn) vBtn.style.display = 'none';
                sessionStorage.removeItem('iptv_provider_search_state');
                return;
            }
            
            // Clear search input since we are browsing category instead
            const searchInput = document.getElementById('iptv-search-input');
            if (searchInput) searchInput.value = '';
            sessionStorage.setItem('iptv_provider_search_state', JSON.stringify({ type: 'category', val: cat }));
            
            resultsContainer.innerHTML = '<div style="color: var(--text-secondary); padding: 10px; text-align: center;">Loading channels...</div>';
            
            try {
                const res = await fetch(getApiUrl(`api/channels?category=${encodeURIComponent(cat)}`));
                const data = await safeParseJson(res);
                
                resultsContainer.innerHTML = '';
                if (!Array.isArray(data) || data.length === 0) {
                    window.currentIptvSearchResults = [];
                    if (vBtn) vBtn.style.display = 'none';
                    resultsContainer.innerHTML = '<div style="color: var(--text-secondary); padding: 10px; text-align: center;">No channels found in this category</div>';
                    return;
                }
                
                window.currentIptvSearchResults = data;
                if (vBtn) {
                    vBtn.style.display = 'inline-flex';
                    vBtn.innerHTML = `⚡ Verify Visible (${Math.min(100, data.length)})`;
                }

                const header = document.createElement('div');
                header.style.display = 'flex';
                header.style.justifyContent = 'space-between';
                header.style.alignItems = 'center';
                header.style.padding = '0 10px 10px 10px';
                header.style.borderBottom = '1px solid var(--line)';
                header.style.marginBottom = '15px';
                header.style.flexWrap = 'wrap';
                header.style.gap = '10px';
                
                const title = document.createElement('span');
                title.style.fontWeight = '700';
                title.style.color = 'var(--accent)';
                title.style.fontSize = '14px';
                title.textContent = `${data.length} Channels Found`;
                header.appendChild(title);
                
                const headerActions = document.createElement('div');
                headerActions.style.display = 'flex';
                headerActions.style.gap = '8px';
                headerActions.style.alignItems = 'center';

                const verifyAllBtn = document.createElement('button');
                verifyAllBtn.className = 'btn btn-secondary';
                verifyAllBtn.style.padding = '6px 12px';
                verifyAllBtn.style.fontSize = '12px';
                verifyAllBtn.textContent = `⚡ Verify Visible (${Math.min(100, data.length)})`;
                verifyAllBtn.title = 'Batch test playability for visible channels';
                verifyAllBtn.onclick = () => verifyVisibleIptvSearchResults();

                const addAllBtn = document.createElement('button');
                addAllBtn.className = 'btn btn-primary';
                addAllBtn.style.padding = '6px 12px';
                addAllBtn.style.fontSize = '12px';
                addAllBtn.textContent = 'Add All to Playlist';
                addAllBtn.onclick = () => {
                    data.forEach(ch => {
                        const isYt = (ch.url && (ch.url.includes('youtube.com') || ch.url.includes('youtu.be')));
                        const newStream = {
                            url: ch.url,
                            type: isYt ? 'youtube_embed' : 'generic'
                        };
                        if (ch.name) newStream.name = ch.name;
                        if (ch.category) newStream.category = ch.category;
                        playlistData.streams.push(newStream);
                    });
                    isFormModified = true;
                    renderCategorizedGrid();
                    sessionStorage.setItem('iptv_restore_search_on_load', 'true');
                    addAllBtn.textContent = 'Added All! ✓';
                    addAllBtn.style.background = '#dcfce7';
                    addAllBtn.style.borderColor = '#86efac';
                    addAllBtn.style.color = '#15803d';
                    document.querySelectorAll('#iptv-search-results button').forEach(b => {
                        if (b.textContent === '+ Add to Playlist') {
                            b.textContent = '✓ In Playlist';
                            b.style.background = '#dcfce7';
                            b.style.color = '#15803d';
                            b.style.borderColor = '#86efac';
                        }
                    });
                };

                headerActions.appendChild(verifyAllBtn);
                headerActions.appendChild(addAllBtn);
                header.appendChild(headerActions);
                resultsContainer.appendChild(header);
                
                data.forEach(ch => {
                    const item = document.createElement('div');
                    item.style.display = 'flex';
                    item.style.justifyContent = 'space-between';
                    item.style.alignItems = 'center';
                    item.style.padding = '10px 14px';
                    item.style.background = '#ffffff';
                    item.style.border = '1px solid var(--line)';
                    item.style.borderRadius = '10px';
                    item.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                    item.style.fontSize = '13px';
                    item.style.color = 'var(--ink)';
                    item.style.flexWrap = 'wrap';
                    item.style.gap = '10px';
                    
                    const label = document.createElement('div');
                    label.style.display = 'flex';
                    label.style.alignItems = 'center';
                    label.style.gap = '8px';
                    label.style.flexWrap = 'wrap';
                    label.style.fontWeight = '600';
                    label.style.flex = '1';
                    label.style.minWidth = '220px';

                    let labelText = escapeHtml(ch.name || 'Unnamed Channel');
                    if (ch.provider) {
                        labelText += ` <span style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">🏷️ ${escapeHtml(ch.provider)}</span>`;
                    }
                    if (ch.live_title) {
                        labelText += ` <span style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">🔴 Live: ${escapeHtml(ch.live_title)}</span>`;
                    }
                    
                    const textSpan = document.createElement('span');
                    textSpan.innerHTML = labelText;
                    label.appendChild(textSpan);

                    const statusBadge = document.createElement('span');
                    if (ch.id) statusBadge.id = `iptv-search-status-${ch.id}`;
                    statusBadge.style.display = 'inline-flex';
                    statusBadge.style.alignItems = 'center';
                    statusBadge.innerHTML = renderChannelStatusBadge(ch);
                    label.appendChild(statusBadge);
                    
                    const btnContainer = document.createElement('div');
                    btnContainer.style.display = 'flex';
                    btnContainer.style.gap = '8px';
                    btnContainer.style.alignItems = 'center';
                    btnContainer.style.flexShrink = '0';

                    const verifyBtn = document.createElement('button');
                    verifyBtn.className = 'btn btn-secondary';
                    verifyBtn.style.padding = '6px 12px';
                    verifyBtn.style.fontSize = '12px';
                    verifyBtn.textContent = '⚡ Verify';
                    verifyBtn.title = 'Verify stream playability & latency';
                    verifyBtn.onclick = (e) => {
                        e.stopPropagation();
                        verifyIptvSearchChannel(ch, verifyBtn, statusBadge);
                    };

                    const testBtn = document.createElement('button');
                    testBtn.className = 'btn btn-secondary';
                    testBtn.style.padding = '6px 12px';
                    testBtn.style.fontSize = '12px';
                    testBtn.textContent = '🔗 Test';
                    testBtn.title = 'Test stream in embedded preview';
                    testBtn.onclick = (e) => {
                        e.stopPropagation();
                        testCardStream(ch.url, ch.name || '');
                    };

                    const isAlreadyAdded = (playlistData && Array.isArray(playlistData.streams) && playlistData.streams.some(s => s && s.url === ch.url));
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-secondary';
                    btn.style.padding = '6px 12px';
                    btn.style.fontSize = '12px';
                    if (isAlreadyAdded) {
                        btn.textContent = '✓ In Playlist';
                        btn.style.background = '#dcfce7';
                        btn.style.color = '#15803d';
                        btn.style.borderColor = '#86efac';
                    } else {
                        btn.textContent = '+ Add to Playlist';
                    }
                    btn.onclick = () => {
                        const isYt = (ch.url && (ch.url.includes('youtube.com') || ch.url.includes('youtu.be')));
                        const newStream = {
                            url: ch.url,
                            type: isYt ? 'youtube_embed' : 'generic'
                        };
                        if (ch.name) newStream.name = ch.name;
                        if (ch.category) newStream.category = ch.category;
                        
                        playlistData.streams.push(newStream);
                        isFormModified = true;
                        renderCategorizedGrid();
                        
                        sessionStorage.setItem('iptv_restore_search_on_load', 'true');
                        
                        btn.style.background = '#dcfce7';
                        btn.style.borderColor = '#86efac';
                        btn.style.color = '#15803d';
                        btn.textContent = 'Added! ✓';
                        setTimeout(() => {
                            btn.textContent = '✓ In Playlist';
                        }, 1500);
                    };
                    
                    btnContainer.appendChild(verifyBtn);
                    btnContainer.appendChild(testBtn);
                    btnContainer.appendChild(btn);

                    item.appendChild(label);
                    item.appendChild(btnContainer);
                    resultsContainer.appendChild(item);
                });
            } catch (err) {
                console.error("Browse category channels failed:", err);
                resultsContainer.innerHTML = `<div style="color: var(--danger-color); padding: 10px; text-align: center;">Error loading channels: ${err.message}</div>`;
            }
        }

        function scrollToIptvSearch() {
            if (typeof switchPortalTab === 'function') {
                switchPortalTab('studio');
            }
            const section = document.getElementById('iptv-search-section') || document.getElementById('iptv-search-input');
            if (section) {
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                section.style.transition = 'box-shadow 0.3s ease, border-color 0.3s ease';
                section.style.borderColor = '#3b82f6';
                section.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.25)';
                setTimeout(() => {
                    section.style.borderColor = '';
                    section.style.boxShadow = '';
                }, 2200);
            }
            const input = document.getElementById('iptv-search-input');
            const select = document.getElementById('iptv-category-select');
            const results = document.getElementById('iptv-search-results');

            // If search results are missing, immediately re-populate them
            const hasItems = results && results.children.length > 0 && !results.textContent.includes('No channels found');
            if (!hasItems) {
                if (input && input.value.trim().length >= 2) {
                    onIptvSearchInput(input.value.trim(), true);
                } else if (select && select.value) {
                    onIptvCategorySelect(select.value);
                } else {
                    restoreIptvSearchState();
                }
            }

            if (input) {
                setTimeout(() => input.focus(), 200);
            }
        }

        async function restoreIptvSearchState() {
            const rawState = sessionStorage.getItem('iptv_provider_search_state') || localStorage.getItem('iptv_provider_search_state');
            if (!rawState) return;

            try {
                const state = JSON.parse(rawState);
                if (typeof switchPortalTab === 'function') {
                    switchPortalTab('studio');
                }

                if (state.type === 'query' && state.val) {
                    const input = document.getElementById('iptv-search-input');
                    const results = document.getElementById('iptv-search-results');
                    if (input && (!results || results.children.length === 0 || input.value !== state.val)) {
                        input.value = state.val;
                        onIptvSearchInput(state.val, true);
                        setTimeout(scrollToIptvSearch, 350);
                    }
                } else if (state.type === 'category' && state.val) {
                    const select = document.getElementById('iptv-category-select');
                    const results = document.getElementById('iptv-search-results');
                    if (select && (!results || results.children.length === 0 || select.value !== state.val)) {
                        if (select.options.length <= 1) {
                            await loadIptvCategories();
                        }
                        select.value = state.val;
                        await onIptvCategorySelect(state.val);
                        setTimeout(scrollToIptvSearch, 350);
                    }
                }
            } catch (e) {
                console.error('Failed to restore IPTV search state:', e);
            }
        }

        /* =========================================================================
           PLUTO TV & TUBI TV SEARCH LOGIC
           ========================================================================= */
        let plutoSearchTimeout = null;

        async function loadPlutoCategories() {
            const select = document.getElementById('pluto-category-select');
            if (!select) return;
            try {
                const res = await fetch(getApiUrl('api/pluto/categories'));
                const categories = await res.json();
                categories.forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.textContent = cat;
                    select.appendChild(opt);
                });
            } catch (e) {
                console.error("Failed loading Pluto categories:", e);
            }
        }

        function triggerPlutoSearch(term) {
            const input = document.getElementById('pluto-search-input');
            const catSelect = document.getElementById('pluto-category-select');
            if (catSelect) catSelect.value = '';
            if (input) {
                input.value = term;
                performPlutoSearch(term, '');
            }
        }

        function onPlutoSearchInput(val) {
            if (plutoSearchTimeout) clearTimeout(plutoSearchTimeout);
            const catSelect = document.getElementById('pluto-category-select');
            if (catSelect) catSelect.value = '';
            const query = val.trim();
            if (query.length < 2) {
                const c = document.getElementById('pluto-search-results');
                if (c) c.innerHTML = '';
                return;
            }
            plutoSearchTimeout = setTimeout(() => {
                performPlutoSearch(query, '');
            }, 300);
        }

        function onPlutoCategorySelect(cat) {
            const input = document.getElementById('pluto-search-input');
            if (input) input.value = '';
            performPlutoSearch('', cat);
        }

        async function performPlutoSearch(query, category) {
            const container = document.getElementById('pluto-search-results');
            if (!container) return;
            if (!query && !category) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = '<div style="color: var(--muted); padding: 12px; font-size: 13px; text-align: center;">🟡 Searching Pluto TV live channels...</div>';
            try {
                let url = `api/pluto/search?`;
                if (query) url += `q=${encodeURIComponent(query)}&`;
                if (category) url += `category=${encodeURIComponent(category)}`;
                const res = await fetch(getApiUrl(url));
                const results = await res.json();
                renderPlutoResults(results);
            } catch (err) {
                container.innerHTML = `<div style="color: var(--danger-color); padding: 10px; font-size: 13px; text-align: center;">Error loading Pluto TV: ${err}</div>`;
            }
        }

        function renderPlutoResults(channels) {
            const container = document.getElementById('pluto-search-results');
            if (!container) return;
            container.innerHTML = '';
            if (!Array.isArray(channels) || channels.length === 0) {
                container.innerHTML = '<div style="color: var(--muted); padding: 12px; font-size: 13px; text-align: center;">No Pluto TV channels found.</div>';
                return;
            }
            channels.forEach(ch => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.justifyContent = 'space-between';
                item.style.alignItems = 'center';
                item.style.padding = '10px 14px';
                item.style.background = '#ffffff';
                item.style.border = '1px solid var(--line)';
                item.style.borderRadius = '10px';
                item.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                item.style.fontSize = '13px';
                item.style.color = 'var(--ink)';
                item.style.gap = '10px';

                const left = document.createElement('div');
                left.style.display = 'flex';
                left.style.alignItems = 'center';
                left.style.gap = '12px';
                left.style.flex = '1';
                left.style.minWidth = '0';

                const logoHtml = ch.logo ? `<img src="${safeLogoUrl(ch.logo)}" style="width: 44px; height: 28px; object-fit: contain; background: #000; border-radius: 4px; padding: 2px;" loading="lazy" onerror="this.style.display='none'">` : `<div style="width: 44px; height: 28px; background: #fef08a; color: #854d0e; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11px;">PLUTO</div>`;

                const meta = document.createElement('div');
                meta.style.minWidth = '0';
                meta.innerHTML = `
                    <div style="font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        <span>${ch.name}</span>
                        <span style="background: #fefce8; color: #a16207; border: 1px solid #fef08a; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">${ch.category || 'Pluto TV'}</span>
                    </div>
                    ${ch.summary ? `<div style="font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 500px;">${ch.summary}</div>` : ''}
                `;

                left.innerHTML = logoHtml;
                left.appendChild(meta);

                const btnContainer = document.createElement('div');
                btnContainer.style.display = 'flex';
                btnContainer.style.gap = '8px';
                btnContainer.style.alignItems = 'center';
                btnContainer.style.flexShrink = '0';

                const testBtn = document.createElement('button');
                testBtn.className = 'btn btn-secondary';
                testBtn.style.padding = '6px 12px';
                testBtn.style.fontSize = '12px';
                testBtn.textContent = '🔗 Test';
                testBtn.title = 'Test stream in embedded preview';
                testBtn.onclick = (e) => {
                    e.stopPropagation();
                    testCardStream(ch.url, ch.name || '');
                };

                const addBtn = document.createElement('button');
                addBtn.className = 'btn btn-secondary';
                addBtn.style.padding = '6px 12px';
                addBtn.style.fontSize = '12px';
                addBtn.textContent = '+ Add to Playlist';
                addBtn.onclick = () => {
                    if (!playlistData.streams) playlistData.streams = [];
                    playlistData.streams.push({
                        name: ch.name,
                        url: ch.url,
                        category: ch.category ? `Pluto TV - ${ch.category}` : 'Pluto TV',
                        logo: ch.logo || '',
                        type: 'generic'
                    });
                    isFormModified = true;
                    renderCategorizedGrid();
                    addBtn.style.background = 'var(--success-color)';
                    addBtn.style.borderColor = 'var(--success-color)';
                    addBtn.style.color = '#fff';
                    addBtn.textContent = 'Added! ✓';
                    setTimeout(() => {
                        addBtn.className = 'btn btn-secondary';
                        addBtn.style.background = '';
                        addBtn.style.borderColor = '';
                        addBtn.style.color = '';
                        addBtn.textContent = '+ Add to Playlist';
                    }, 1500);
                };

                btnContainer.appendChild(testBtn);
                btnContainer.appendChild(addBtn);

                item.appendChild(left);
                item.appendChild(btnContainer);
                container.appendChild(item);
            });
        }

        // Tubi TV Search & Explorer Logic
        let tubiSearchTimeout = null;

        async function loadTubiCategories() {
            const select = document.getElementById('tubi-category-select');
            if (!select) return;
            try {
                const res = await fetch(getApiUrl('api/tubi/categories'));
                const categories = await res.json();
                select.innerHTML = '<option value="">📂 Browse Tubi Category...</option>';
                if (Array.isArray(categories)) {
                    categories.forEach(cat => {
                        if (cat && cat.trim() && cat.toLowerCase() !== 'other') {
                            const opt = document.createElement('option');
                            opt.value = cat;
                            opt.textContent = cat;
                            select.appendChild(opt);
                        }
                    });
                }
            } catch (e) {
                console.error("Failed loading Tubi categories:", e);
            }
        }

        function triggerTubiSearch(term) {
            const input = document.getElementById('tubi-search-input');
            const catSelect = document.getElementById('tubi-category-select');
            if (catSelect) catSelect.value = '';
            if (input) {
                input.value = term;
                performTubiSearch(term, '');
            }
        }

        function onTubiSearchInput(val) {
            if (tubiSearchTimeout) clearTimeout(tubiSearchTimeout);
            const catSelect = document.getElementById('tubi-category-select');
            if (catSelect) catSelect.value = '';
            const query = val.trim();
            if (query.length < 2) {
                const c = document.getElementById('tubi-search-results');
                if (c) c.innerHTML = '';
                return;
            }
            tubiSearchTimeout = setTimeout(() => {
                performTubiSearch(query, '');
            }, 300);
        }

        function onTubiCategorySelect(cat) {
            const input = document.getElementById('tubi-search-input');
            if (input) input.value = '';
            performTubiSearch('', cat);
        }

        async function performTubiSearch(query, category) {
            const container = document.getElementById('tubi-search-results');
            if (!container) return;
            if (!query && !category) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = '<div style="color: var(--muted); padding: 12px; font-size: 13px; text-align: center;">🟣 Searching Tubi TV live channels...</div>';
            try {
                let url = `api/tubi/search?`;
                if (query) url += `q=${encodeURIComponent(query)}&`;
                if (category) url += `category=${encodeURIComponent(category)}`;
                const res = await fetch(getApiUrl(url));
                const results = await res.json();
                renderTubiResults(results);
            } catch (err) {
                container.innerHTML = `<div style="color: var(--danger-color); padding: 10px; font-size: 13px; text-align: center;">Error loading Tubi TV: ${err}</div>`;
            }
        }

        function renderTubiResults(channels) {
            const container = document.getElementById('tubi-search-results');
            if (!container) return;
            container.innerHTML = '';
            if (!Array.isArray(channels) || channels.length === 0) {
                container.innerHTML = '<div style="color: var(--muted); padding: 12px; font-size: 13px; text-align: center;">No Tubi TV channels found.</div>';
                return;
            }
            channels.forEach(ch => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.justifyContent = 'space-between';
                item.style.alignItems = 'center';
                item.style.padding = '10px 14px';
                item.style.background = '#ffffff';
                item.style.border = '1px solid var(--line)';
                item.style.borderRadius = '10px';
                item.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                item.style.fontSize = '13px';
                item.style.color = 'var(--ink)';
                item.style.gap = '10px';

                const left = document.createElement('div');
                left.style.display = 'flex';
                left.style.alignItems = 'center';
                left.style.gap = '12px';
                left.style.flex = '1';
                left.style.minWidth = '0';

                const logoHtml = ch.logo ? `<img src="${safeLogoUrl(ch.logo)}" style="width: 44px; height: 28px; object-fit: contain; background: #000; border-radius: 4px; padding: 2px;" loading="lazy" onerror="this.style.display='none'">` : `<div style="width: 44px; height: 28px; background: #e9d5ff; color: #6b21a8; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11px;">TUBI</div>`;

                const meta = document.createElement('div');
                meta.style.minWidth = '0';
                meta.innerHTML = `
                    <div style="font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        <span>${ch.name}</span>
                        <span style="background: #faf5ff; color: #7e22ce; border: 1px solid #e9d5ff; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">${ch.category || 'Tubi TV'}</span>
                    </div>
                `;

                left.innerHTML = logoHtml;
                left.appendChild(meta);

                const btnContainer = document.createElement('div');
                btnContainer.style.display = 'flex';
                btnContainer.style.gap = '8px';
                btnContainer.style.alignItems = 'center';
                btnContainer.style.flexShrink = '0';

                const testBtn = document.createElement('button');
                testBtn.className = 'btn btn-secondary';
                testBtn.style.padding = '6px 12px';
                testBtn.style.fontSize = '12px';
                testBtn.textContent = '🔗 Test';
                testBtn.title = 'Test stream in embedded preview';
                testBtn.onclick = (e) => {
                    e.stopPropagation();
                    testCardStream(ch.url, ch.name || '');
                };

                const addBtn = document.createElement('button');
                addBtn.className = 'btn btn-secondary';
                addBtn.style.padding = '6px 12px';
                addBtn.style.fontSize = '12px';
                addBtn.textContent = '+ Add to Playlist';
                addBtn.onclick = () => {
                    if (!playlistData.streams) playlistData.streams = [];
                    playlistData.streams.push({
                        name: ch.name,
                        url: ch.url,
                        category: ch.category ? `Tubi TV - ${ch.category}` : 'Tubi TV',
                        logo: ch.logo || '',
                        type: 'generic'
                    });
                    isFormModified = true;
                    renderCategorizedGrid();
                    addBtn.style.background = 'var(--success-color)';
                    addBtn.style.borderColor = 'var(--success-color)';
                    addBtn.style.color = '#fff';
                    addBtn.textContent = 'Added! ✓';
                    setTimeout(() => {
                        addBtn.className = 'btn btn-secondary';
                        addBtn.style.background = '';
                        addBtn.style.borderColor = '';
                        addBtn.style.color = '';
                        addBtn.textContent = '+ Add to Playlist';
                    }, 1500);
                };

                btnContainer.appendChild(testBtn);
                btnContainer.appendChild(addBtn);

                item.appendChild(left);
                item.appendChild(btnContainer);
                container.appendChild(item);
            });
        }

        /* =========================================================================
           PORTAL VIEW & MOBILE STREAMING LOGIC
           ========================================================================= */
        let portalActiveIndex = -1;
        let portalActiveCategory = 'ALL';
        let portalActiveProvider = 'ALL';
        let portalGroupBy = 'provider'; // default to arranging by provider!
        let studioGroupBy = 'provider';
        let portalSearchQuery = '';
        const _portalUrlParams = new URLSearchParams(window.location.search);
        let portalViewMode = (_portalUrlParams.get('layout') === 'tvguide' || _portalUrlParams.get('view') === 'tvguide' || _portalUrlParams.get('layout') === 'timeline' || _portalUrlParams.get('user') === (((window.IPTV_CONFIG || {}).adminUser || 'admin') + '_custom'))
            ? 'timeline'
            : (localStorage.getItem('stream_iptv_view_mode') || 'grid');
        let portalEpgCache = null;
        let portalEpgLastFetch = 0;
        let portalEpgLoadingPromise = null;

        const PROVIDER_SORT_ORDER = {
            '⚡ Primary Provider': 2,
            '📺 YouTube Live': 3,
            '🪐 Pluto TV': 4,
            '🍿 Tubi TV': 5,
            '🌐 Other Providers': 6
        };

        function getStreamProvider(s) {
            if (!s) return '🌐 Other Providers';
            if (s.provider && s.provider.trim()) {
                const p = s.provider.trim();
                if (p === 'Primary Provider') return '⚡ Primary Provider';
                if (p === 'YouTube' || p === 'YouTube Live') return '📺 YouTube Live';
                if (p === 'Pluto' || p === 'Pluto TV') return '🪐 Pluto TV';
                if (p === 'Tubi' || p === 'Tubi TV') return '🍿 Tubi TV';
                return p;
            }
            const url = (s.url || '').toLowerCase();
            const name = (s.name || '').toLowerCase();
            const stype = (s.type || '').toLowerCase();
            if (url.includes('youtube.com') || url.includes('youtu.be') || stype === 'youtube_embed') {
                return '📺 YouTube Live';
            }
            if (url.includes('jmp2.uk') || url.includes('pluto.tv') || name.includes('pluto tv')) {
                return '🪐 Pluto TV';
            }
            if (url.includes('tubi.video') || url.includes('production-public.tubi') || name.includes('fox local') || name.includes('tubi')) {
                return '🍿 Tubi TV';
            }
            return '🌐 Other Providers';
        }

        window.getStreamProvider = getStreamProvider;

        function setPortalGroupBy(mode) {
            portalGroupBy = mode;
            portalActiveProvider = 'ALL';
            portalActiveCategory = 'ALL';
            renderPortalCategories();
            renderPortalChannels();
        }
        window.setPortalGroupBy = setPortalGroupBy;

        function isStreamOffline(s) {
            if (!s || typeof s !== 'object') return false;
            return Boolean(s.offline || s.is_offline);
        }
        window.isStreamOffline = isStreamOffline;

        function updateOfflineVisibility() {
            const streams = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData.streams : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData.streams : [];
            const offlineStreams = streams.filter(s => s && (s.offline || s.is_offline));
            const count = offlineStreams.length;

            const headerBadge = document.getElementById('header-offline-badge');
            const headerCount = document.getElementById('header-offline-count');
            if (headerBadge) headerBadge.style.display = count > 0 ? 'inline-flex' : 'none';
            if (headerCount) headerCount.textContent = count;

            const banner = document.getElementById('portal-offline-banner');
            const bannerCount = document.getElementById('offline-banner-count');
            const bannerBtnCount = document.getElementById('offline-banner-btn-count');
            if (banner) banner.style.display = count > 0 ? 'flex' : 'none';
            if (bannerCount) bannerCount.textContent = count;
            if (bannerBtnCount) bannerBtnCount.textContent = count;

            const mobileOfflineBtn = document.getElementById('mobile-offline-btn');
            const mobileOfflineCount = document.getElementById('mobile-offline-count');
            if (mobileOfflineBtn) mobileOfflineBtn.style.display = count > 0 ? 'flex' : 'none';
            if (mobileOfflineCount) mobileOfflineCount.textContent = count;

            const modal = document.getElementById('offline-channels-modal');
            if (modal && modal.style.display === 'flex') {
                renderOfflineModalList();
            }
        }
        window.updateOfflineVisibility = updateOfflineVisibility;

        function selectPortalProvider(prov) {
            portalActiveProvider = prov;
            if (portalActiveCategory === '__OFFLINE__') portalActiveCategory = 'ALL';
            renderPortalCategories();
            renderPortalChannels();
        }
        window.selectPortalProvider = selectPortalProvider;

        function selectPortalCategory(cat) {
            portalActiveCategory = cat;
            if (portalActiveProvider === '__OFFLINE__') portalActiveProvider = 'ALL';
            renderPortalCategories();
            renderPortalChannels();
        }
        window.selectPortalCategory = selectPortalCategory;

        function selectPortalOfflineFilter() {
            switchPortalTab('watch');
            portalActiveProvider = '__OFFLINE__';
            portalActiveCategory = '__OFFLINE__';
            renderPortalCategories();
            renderPortalChannels();
            const banner = document.getElementById('portal-offline-banner');
            if (banner) {
                banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
        window.selectPortalOfflineFilter = selectPortalOfflineFilter;

        function openOfflineChannelsModal() {
            renderOfflineModalList();
            const modal = document.getElementById('offline-channels-modal');
            if (modal) modal.style.display = 'flex';
        }
        window.openOfflineChannelsModal = openOfflineChannelsModal;

        function closeOfflineChannelsModal() {
            const modal = document.getElementById('offline-channels-modal');
            if (modal) modal.style.display = 'none';
        }
        window.closeOfflineChannelsModal = closeOfflineChannelsModal;

        function renderOfflineModalList() {
            const listEl = document.getElementById('modal-offline-list');
            const countEl = document.getElementById('modal-offline-count');
            if (!listEl) return;

            const pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
            const streams = pd && Array.isArray(pd.streams) ? pd.streams : [];
            const offlineItems = [];
            streams.forEach((s, idx) => {
                if (s && (s.offline || s.is_offline)) {
                    offlineItems.push({ stream: s, index: idx });
                }
            });

            if (countEl) countEl.textContent = offlineItems.length;

            if (offlineItems.length === 0) {
                listEl.innerHTML = `
                    <div style="text-align: center; padding: 40px 20px; color: #166534; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px;">
                        <div style="font-size: 32px; margin-bottom: 8px;">🟢</div>
                        <div style="font-size: 15px; font-weight: 700;">All Channels Online!</div>
                        <div style="font-size: 12px; color: #15803d; margin-top: 4px;">No streams are currently marked offline or failing verification.</div>
                    </div>
                `;
                return;
            }

            let html = '';
            offlineItems.forEach(({ stream, index }) => {
                const name = escapeHtml(stream.name || `Channel ${index + 1}`);
                const prov = escapeHtml(getStreamProvider(stream));
                const cat = escapeHtml(stream.category || 'General');
                const url = escapeHtml(stream.url || '');
                const err = escapeHtml(stream.last_error || 'Stream offline');
                const since = escapeHtml(stream.offline_since || 'Recent health check');

                html += `
                    <div style="background: #ffffff; border: 1px solid #fecaca; border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #fee2e2; color: #991b1b; font-weight: 700; font-size: 11px; padding: 2px 7px; border-radius: 6px;">#${index + 1}</span>
                                <span style="font-weight: 700; font-size: 13px; color: #1e293b;">${name}</span>
                                <span style="font-size: 11px; color: #64748b; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${prov}</span>
                                <span style="font-size: 11px; color: #64748b; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${cat}</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <button type="button" class="btn btn-secondary" onclick="healSingleOfflineChannel(${index})" style="padding: 3px 9px; font-size: 11px; font-weight: 600; color: #1d4ed8; border-color: #bfdbfe; background: #eff6ff; cursor: pointer;" title="Search channels.db for active replacement stream">🔍 Find Fix</button>
                                <button type="button" class="btn btn-secondary" onclick="closeOfflineChannelsModal(); openEditModal(${index});" style="padding: 3px 9px; font-size: 11px; font-weight: 600; cursor: pointer;">✏️ Edit</button>
                                <button type="button" class="btn btn-secondary" onclick="testCardStreamByIndex(${index})" style="padding: 3px 9px; font-size: 11px; font-weight: 600; cursor: pointer;">🔗 Test</button>
                                <button type="button" class="btn btn-secondary" onclick="closeOfflineChannelsModal(); deleteCardStream(${index});" style="padding: 3px 9px; font-size: 11px; font-weight: 600; color: #dc2626; border-color: #fecaca; background: #fff5f5; cursor: pointer;">❌ Remove</button>
                            </div>
                        </div>
                        <div style="font-family: monospace; font-size: 11px; color: #475569; word-break: break-all; background: #f8fafc; padding: 4px 8px; border-radius: 4px; border: 1px solid #e2e8f0;">
                            ${url}
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #dc2626; flex-wrap: wrap; gap: 6px;">
                            <span style="font-weight: 600;">⚠️ Failure Reason: <strong style="color: #991b1b;">${err}</strong></span>
                            <span style="color: #64748b;">Marked offline: ${since}</span>
                        </div>
                    </div>
                `;
            });

            listEl.innerHTML = html;
        }
        window.renderOfflineModalList = renderOfflineModalList;

        async function healSingleOfflineChannel(index) {
            const pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
            if (!pd || !pd.streams || !pd.streams[index]) return;
            const stream = pd.streams[index];
            const name = stream.name || '';
            const url = stream.url || '';

            if (typeof showToast === 'function') showToast(`🔍 Searching channels.db for working fix for "${name}"...`);
            try {
                const u = (typeof currentUser !== 'undefined' && currentUser && currentUser !== 'default') ? currentUser : ((window.IPTV_CONFIG || {}).adminUser || 'admin');
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/channel/preflight`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, url: url, user: u })
                });
                const data = await res.json();
                if (data.healed && data.url) {
                    stream.url = data.url;
                    if (data.provider) stream.provider = data.provider;
                    delete stream.offline;
                    delete stream.is_offline;
                    delete stream.last_error;
                    delete stream.offline_since;

                    const userParam = u !== 'default' ? `?user=${encodeURIComponent(u)}` : '';
                    await fetch(`${base}api/playlist${userParam}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(pd)
                    });

                    if (typeof showToast === 'function') showToast(`✅ Fixed "${name}"! Replaced with working link.`);
                    renderOfflineModalList();
                    renderPortalView();
                    renderCategorizedGrid();
                } else {
                    if (typeof showToast === 'function') showToast(`❌ No working replacement found in DB for "${name}". Try Refresh All DB first.`);
                    else alert(`No working replacement found in DB for "${name}".`);
                }
            } catch (err) {
                if (typeof showToast === 'function') showToast(`❌ Error healing channel: ${err.message}`);
                else alert(`Error healing channel: ${err.message}`);
            }
        }
        window.healSingleOfflineChannel = healSingleOfflineChannel;

        async function healAllOfflineChannels() {
            const btn = document.getElementById('btn-modal-heal-all');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '⏳ Auto-healing...';
            }
            if (typeof showToast === 'function') showToast('🩺 Probing channels and auto-healing from channels.db...');
            try {
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/playlist/verify`, { method: 'POST' });
                let polls = 0;
                const interval = setInterval(async () => {
                    polls++;
                    try {
                        const sRes = await fetch(`${base}api/playlist/verify-status`);
                        const sData = await sRes.json();
                        if (sData.status === 'done') {
                            clearInterval(interval);
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = '🔍 Find Fix (Auto-Heal All)';
                            }
                            if (typeof showToast === 'function') showToast(sData.summary || '✅ Auto-heal scan completed!');
                            setTimeout(() => { location.reload(); }, 1200);
                        } else if (sData.status === 'error' || polls > 90) {
                            clearInterval(interval);
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = '🔍 Find Fix (Auto-Heal All)';
                            }
                            if (typeof showToast === 'function') showToast('❌ Auto-heal completed with errors or timeout.');
                        }
                    } catch (e) {
                        console.warn(e);
                    }
                }, 2000);
            } catch (err) {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '🔍 Find Fix (Auto-Heal All)';
                }
                if (typeof showToast === 'function') showToast(`❌ Failed to start auto-heal: ${err.message}`);
            }
        }
        window.healAllOfflineChannels = healAllOfflineChannels;

        async function cleanAllBrokenChannels() {
            const pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
            if (!pd || !Array.isArray(pd.streams)) return;

            const brokenItems = [];
            pd.streams.forEach((s, idx) => {
                if (s && (s.offline || s.is_offline)) {
                    brokenItems.push(s.name || `Channel ${idx+1}`);
                }
            });

            if (brokenItems.length === 0) {
                alert('No broken channels found to clean.');
                return;
            }

            if (!confirm(`Are you sure you want to remove all ${brokenItems.length} offline/broken channel(s) from your active playlist?\n\nChannels to be removed:\n- ` + brokenItems.slice(0, 8).join('\n- ') + (brokenItems.length > 8 ? `\n...and ${brokenItems.length - 8} more` : ''))) {
                return;
            }

            pd.streams = pd.streams.filter(s => !s || (!s.offline && !s.is_offline));

            window.playlistData = pd;
            if (typeof playlistData !== 'undefined') playlistData = pd;
            window.isFormModified = true;
            if (typeof isFormModified !== 'undefined') isFormModified = true;

            try {
                const u = (typeof currentUser !== 'undefined' && currentUser && currentUser !== 'default') ? currentUser : ((window.IPTV_CONFIG || {}).adminUser || 'admin');
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const userParam = u !== 'default' ? `?user=${encodeURIComponent(u)}` : '';
                await fetch(`${base}api/playlist${userParam}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pd)
                });

                if (typeof showToast === 'function') showToast(`🗑️ Cleaned ${brokenItems.length} broken channel(s) from active playlist!`);
                renderOfflineModalList();
                renderPortalView();
                renderCategorizedGrid();

                const offlineBadge = document.getElementById('header-offline-badge');
                const offlineCountEl = document.getElementById('header-offline-count');
                const banner = document.getElementById('portal-offline-banner');
                if (offlineCountEl) offlineCountEl.textContent = '0';
                if (offlineBadge) offlineBadge.style.display = 'none';
                if (banner) banner.style.display = 'none';

                setTimeout(() => { closeOfflineChannelsModal(); }, 1200);
            } catch (err) {
                alert(`Failed to save cleaned playlist: ${err.message}`);
            }
        }
        window.cleanAllBrokenChannels = cleanAllBrokenChannels;

        function setStudioGroupBy(mode) {
            studioGroupBy = mode;
            renderCategorizedGrid();
        }
        window.setStudioGroupBy = setStudioGroupBy;

        async function arrangePlaylistByProviders() {
            let pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
            if (!pd || !Array.isArray(pd.streams)) return;

            pd.streams.forEach(s => {
                const p = getStreamProvider(s);
                if (p.includes('Primary')) s.provider = 'Primary Provider';
                else if (p.includes('YouTube')) s.provider = 'YouTube Live';
                else if (p.includes('Pluto')) s.provider = 'Pluto TV';
                else if (p.includes('Tubi')) s.provider = 'Tubi TV';
                else s.provider = p;
            });

            pd.streams.sort((a, b) => {
                const provA = getStreamProvider(a);
                const provB = getStreamProvider(b);
                const orderA = PROVIDER_SORT_ORDER[provA] || 99;
                const orderB = PROVIDER_SORT_ORDER[provB] || 99;
                if (orderA !== orderB) return orderA - orderB;
                const catA = (a.category || '').toLowerCase();
                const catB = (b.category || '').toLowerCase();
                if (catA !== catB) return catA.localeCompare(catB);
                return (a.name || '').localeCompare(b.name || '');
            });

            window.playlistData = pd;
            if (typeof playlistData !== 'undefined') playlistData = pd;
            window.isFormModified = true;
            if (typeof isFormModified !== 'undefined') isFormModified = true;

            renderPortalView();
            renderCategorizedGrid();

            try {
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const userParam = (typeof currentUser !== 'undefined' && currentUser && currentUser !== 'default') ? `?user=${encodeURIComponent(currentUser)}` : '';
                await fetch(`${base}api/playlist${userParam}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pd)
                });
                if (typeof showToast === 'function') showToast('✅ Playlist arranged & saved by providers!');
                else alert('Playlist arranged & saved by providers!');
            } catch (err) {
                console.warn('Failed to auto-save after arrange:', err);
                if (typeof showToast === 'function') showToast('⚠️ Arranged locally (save error)');
            }
        }
        window.arrangePlaylistByProviders = arrangePlaylistByProviders;

        function switchPortalTab(tab) {
            const portalView = document.getElementById('portal-view');
            const studioView = document.getElementById('studio-view');
            const pillWatch = document.getElementById('pill-watch-mode');
            const pillStudio = document.getElementById('pill-studio-mode');
            const bnavWatch = document.getElementById('bnav-watch');
            const bnavTvGuide = document.getElementById('bnav-tvguide');
            const bnavStudio = document.getElementById('bnav-studio');

            if (tab === 'studio') {
                if (portalView) portalView.style.display = 'none';
                if (studioView) studioView.style.display = 'block';

                if (pillWatch) pillWatch.classList.remove('active');
                if (pillStudio) pillStudio.classList.add('active');

                if (bnavWatch) bnavWatch.classList.remove('active');
                if (bnavTvGuide) bnavTvGuide.classList.remove('active');
                if (bnavStudio) bnavStudio.classList.add('active');

                localStorage.setItem('stream_iptv_tab', 'studio');
            } else {
                if (portalView) portalView.style.display = 'block';
                if (studioView) studioView.style.display = 'none';

                if (pillWatch) pillWatch.classList.add('active');
                if (pillStudio) pillStudio.classList.remove('active');

                if (bnavStudio) bnavStudio.classList.remove('active');
                if (portalViewMode === 'timeline') {
                    if (bnavTvGuide) bnavTvGuide.classList.add('active');
                    if (bnavWatch) bnavWatch.classList.remove('active');
                } else {
                    if (bnavWatch) bnavWatch.classList.add('active');
                    if (bnavTvGuide) bnavTvGuide.classList.remove('active');
                }

                localStorage.setItem('stream_iptv_tab', 'watch');
                renderPortalView();
            }
        }

        function initPortalView() {
            const savedTab = localStorage.getItem('stream_iptv_tab') || 'watch';
            setPortalViewMode(portalViewMode);
            renderPortalCategories();
            renderPortalChannels();

            const streams = playlistData.streams || [];
            if (streams.length > 0 && portalActiveIndex === -1) {
                updateHeroPreviewInfo(0, false);
            }

            switchPortalTab(savedTab);
        }

        function renderPortalView() {
            renderPortalCategories();
            renderPortalChannels();
        }

        function renderPortalCategories() {
            const container = document.getElementById('portal-category-pills');
            if (!container) return;

            const streams = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData.streams : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData.streams : [];
            const offlineCount = streams.filter(s => s && (s.offline || s.is_offline)).length;
            const isOfflineActive = portalActiveProvider === '__OFFLINE__' || portalActiveCategory === '__OFFLINE__';
            
            const isProvider = portalGroupBy === 'provider';
            const toggleBar = `
                <div style="display:flex;align-items:center;gap:6px;margin-right:10px;padding-right:10px;border-right:1px solid var(--line);flex-shrink:0;">
                    <button type="button" class="btn btn-secondary" onclick="setPortalGroupBy('provider')" style="padding:4px 9px;font-size:11px;font-weight:${isProvider ? '700' : '500'};background:${isProvider ? 'var(--accent)' : '#fff'};color:${isProvider ? '#fff' : 'var(--ink)'};border:1px solid ${isProvider ? 'var(--accent)' : 'var(--line)'};border-radius:6px;cursor:pointer;" title="Arrange & filter channels by Provider">🏷️ By Provider</button>
                    <button type="button" class="btn btn-secondary" onclick="setPortalGroupBy('category')" style="padding:4px 9px;font-size:11px;font-weight:${!isProvider ? '700' : '500'};background:${!isProvider ? 'var(--accent)' : '#fff'};color:${!isProvider ? '#fff' : 'var(--ink)'};border:1px solid ${!isProvider ? 'var(--accent)' : 'var(--line)'};border-radius:6px;cursor:pointer;" title="Arrange & filter channels by Category">📁 By Category</button>
                    <button type="button" class="btn btn-secondary" onclick="arrangePlaylistByProviders()" style="padding:4px 9px;font-size:11px;font-weight:600;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;" title="Permanently order & save active playlist by providers">🔀 Arrange Playlist</button>
                </div>
            `;

            const offlinePill = offlineCount > 0 ? `
                <button type="button" class="category-pill ${isOfflineActive ? 'active' : ''}" onclick="selectPortalOfflineFilter()" style="border: 1px solid ${isOfflineActive ? '#dc2626' : '#fecaca'}; color: ${isOfflineActive ? '#ffffff' : '#b91c1c'}; background: ${isOfflineActive ? '#dc2626' : '#fff1f2'}; font-weight: 700;" title="Show only offline channels">
                    🔴 Offline (${offlineCount})
                </button>
            ` : '';

            if (isProvider) {
                const providerCounts = {};
                streams.forEach(s => {
                    const p = getStreamProvider(s);
                    providerCounts[p] = (providerCounts[p] || 0) + 1;
                });

                const sortedProviders = Object.keys(providerCounts).sort((a, b) => {
                    return (PROVIDER_SORT_ORDER[a] || 99) - (PROVIDER_SORT_ORDER[b] || 99);
                });

                let html = toggleBar + offlinePill + `
                    <button type="button" class="category-pill ${(!isOfflineActive && portalActiveProvider === 'ALL') ? 'active' : ''}" onclick="selectPortalProvider('ALL')">
                        🌟 All Providers (${streams.length})
                    </button>
                `;

                sortedProviders.forEach(p => {
                    const isActive = (!isOfflineActive && portalActiveProvider === p) ? 'active' : '';
                    html += `
                        <button type="button" class="category-pill ${isActive}" onclick="selectPortalProvider('${escapeHtml(p)}')">
                            ${escapeHtml(providerDisplayLabel(p))} (${providerCounts[p]})
                        </button>
                    `;
                });

                container.innerHTML = html;
            } else {
                const categoryCounts = {};
                streams.forEach(s => {
                    const cat = (s.category || 'General').trim();
                    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
                });

                const sortedCats = Object.keys(categoryCounts).sort((a, b) => a.localeCompare(b));

                let html = toggleBar + offlinePill + `
                    <button type="button" class="category-pill ${(!isOfflineActive && portalActiveCategory === 'ALL') ? 'active' : ''}" onclick="selectPortalCategory('ALL')">
                        🌟 All Categories (${streams.length})
                    </button>
                `;

                sortedCats.forEach(cat => {
                    const isActive = (!isOfflineActive && portalActiveCategory === cat) ? 'active' : '';
                    html += `
                        <button type="button" class="category-pill ${isActive}" onclick="selectPortalCategory('${escapeHtml(cat)}')">
                            ${escapeHtml(cat)} (${categoryCounts[cat]})
                        </button>
                    `;
                });

                container.innerHTML = html;
            }
        }

        function onPortalSearch(val) {
            portalSearchQuery = (val || '').trim().toLowerCase();
            const clearBtn = document.getElementById('portal-search-clear');
            if (clearBtn) {
                clearBtn.style.display = portalSearchQuery ? 'inline-block' : 'none';
            }
            renderPortalChannels();
            searchPortalProviders(portalSearchQuery);
        }

        function clearPortalSearch() {
            const input = document.getElementById('portal-search-input');
            if (input) input.value = '';
            onPortalSearch('');
        }

        function focusPortalSearch() {
            switchPortalTab('watch');
            const input = document.getElementById('portal-search-input');
            if (input) {
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                input.focus();
            }
        }

        // Display-only helpers for channel cards: the stored name/provider never change.
        const KEEP_UPPER_WORDS = new Set(['US', 'UK', 'SP', 'MA', 'NY', 'LA', 'DC', 'CA', 'TV', 'HD', 'DW', 'ABC', 'CBS', 'NBC', 'FOX', 'CNN', 'HGTV', 'ESPN', 'HBO', 'AMC', 'TBS', 'TNT', 'PBS', 'BBC', 'MSNBC', 'CNBC', 'USA', 'KCAL', 'KTLA', 'WFXT', 'NFL', 'NBA', 'MLB', 'NHL', 'TLC', 'MTV']);

        // ALL-CAPS feed names ("24/7 MARRIED WITH CHILDREN") read as Title Case; mixed-case names are left alone.
        function channelDisplayName(raw) {
            const name = String(raw || '').trim();
            const letters = name.replace(/[^A-Za-z]/g, '');
            if (letters.length < 6 || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.8) return name;
            return name.replace(/[A-Za-z][A-Za-z']*/g, w => KEEP_UPPER_WORDS.has(w.toUpperCase()) || w.length === 1
                ? w.toUpperCase()
                : w.charAt(0) + w.slice(1).toLowerCase());
        }

        // Two-letter badge from meaningful words, skipping "24/7", "(US)", "US" prefixes; "CBS: ..." -> "CBS".
        function channelMonogram(raw) {
            const name = String(raw || '').trim();
            const prefix = name.split(':')[0].trim();
            if (name.includes(':') && /^[A-Za-z]{2,4}$/.test(prefix)) return prefix.toUpperCase();
            const cleaned = name.replace(/\([^)]*\)/g, ' ').replace(/24\/7/g, ' ');
            const words = cleaned.match(/[A-Za-z0-9]+/g) || [];
            const noise = new Set(['US', 'UK', 'THE', 'LIVE', 'STREAMING']);
            let useful = words.filter(w => !noise.has(w.toUpperCase()));
            if (!useful.length) useful = words;
            if (!useful.length) return '📺';
            return (useful[0].charAt(0) + (useful[1] ? useful[1].charAt(0) : useful[0].charAt(1) || '')).toUpperCase();
        }

        function monogramHue(text) {
            let h = 0;
            for (const ch of String(text || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
            return h;
        }

        // Providers stored as a raw URL ("http://provider.example:8080") show as the bare host.
        function providerDisplayLabel(p) {
            const s = String(p || '').trim();
            const m = s.match(/^[a-z]+:\/\/([^/:?#]+)/i);
            return m ? m[1] : s;
        }

        function renderChannelCardHtml(stream, index, provider, opts = {}) {
            const isCurrent = portalActiveIndex === index;
            const rawName = stream.name || `Channel ${index + 1}`;
            const nameText = escapeHtml(channelDisplayName(rawName));
            const nameTitle = escapeHtml(rawName);
            const catText = escapeHtml(stream.category || 'General');
            const provText = escapeHtml(providerDisplayLabel(provider || getStreamProvider(stream)));
            const isOffline = Boolean(stream.offline || stream.is_offline);
            const lastErr = stream.last_error ? escapeHtml(stream.last_error) : '';
            
            let logoHtml = '';
            if (stream.logo) {
                const safeSrc = safeLogoUrl(stream.logo);
                logoHtml = `<img class="card-logo-img" src="${escapeHtml(safeSrc)}" alt="${nameText}" onerror="this.outerHTML='<div class=\\'card-logo-fallback\\'>📺</div>'">`;
            } else {
                const mono = channelMonogram(rawName);
                logoHtml = `<div class="card-logo-fallback card-monogram ${mono.length > 2 ? 'is-wide' : ''}" style="--mono-h:${monogramHue(rawName)}">${escapeHtml(mono)}</div>`;
            }

            // Every listed channel is live, so only exceptions get a badge: offline, or the one now playing
            // (the "Playing" tag is shown by CSS on .active, so it follows the active-card toggle without a re-render).
            const statusBadge = isOffline
                ? `<span class="card-live-tag" style="background:#dc2626;color:#ffffff;border:1px solid #b91c1c;" title="${lastErr || 'Stream offline'}">🔴 OFFLINE</span>`
                : `<span class="card-playing-tag">▶ Playing</span>`;

            const offlineNotice = isOffline
                ? `<div style="font-size:11px;color:#dc2626;margin-top:4px;font-weight:600;display:flex;align-items:center;gap:4px;" title="${lastErr}">⚠️ ${lastErr || 'Health check failed'}</div>`
                : '';

            return `
                <div class="portal-channel-card ${isCurrent ? 'active' : ''} ${isOffline ? 'is-offline' : ''}" onclick="playPortalChannel(${index})" data-index="${index}">
                    <div class="card-top-row">
                        ${logoHtml}
                        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                            ${statusBadge}
                            ${opts.inProviderSection ? '' : `<span class="card-provider-tag" title="IPTV Provider">${provText}</span>`}
                        </div>
                    </div>
                    <div class="card-name" title="${nameTitle}">${nameText}</div>
                    <div class="card-category">${catText}</div>
                    ${offlineNotice}
                    ${scheduleSelectHtml(stream, index)}
                </div>
            `;
        }

        function setPortalViewMode(mode) {
            portalViewMode = mode;
            localStorage.setItem('stream_iptv_view_mode', mode);
            const gridBtn = document.getElementById('view-mode-grid');
            const timelineBtn = document.getElementById('view-mode-timeline');
            if (gridBtn) gridBtn.classList.toggle('active', mode === 'grid');
            if (timelineBtn) timelineBtn.classList.toggle('active', mode === 'timeline');
            const bnavWatch = document.getElementById('bnav-watch');
            const bnavTvGuide = document.getElementById('bnav-tvguide');
            const bnavStudio = document.getElementById('bnav-studio');
            const isStudio = localStorage.getItem('stream_iptv_tab') === 'studio';
            if (!isStudio) {
                if (bnavWatch) bnavWatch.classList.toggle('active', mode === 'grid');
                if (bnavTvGuide) bnavTvGuide.classList.toggle('active', mode === 'timeline');
                if (bnavStudio) bnavStudio.classList.remove('active');
            }
            renderPortalChannels();
        }

        function openMobileWatch() {
            switchPortalTab('watch');
            setPortalViewMode('grid');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function openMobileTVGuide() {
            switchPortalTab('watch');
            setPortalViewMode('timeline');
            const el = document.getElementById('portal-tvguide-container');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        }

        function focusPortalSearch() {
            switchPortalTab('watch');
            const input = document.getElementById('portal-search-input');
            if (input) {
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        function openMobileStudio() {
            switchPortalTab('studio');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function openMobileActionDrawer() {
            const drawer = document.getElementById('mobile-action-drawer');
            if (!drawer) return;
            drawer.classList.add('active');
            document.body.style.overflow = 'hidden';

            // Sync offline channels count and visibility
            const headerOfflineCount = document.getElementById('header-offline-count');
            const mobileOfflineCount = document.getElementById('mobile-offline-count');
            const mobileOfflineBtn = document.getElementById('mobile-offline-btn');
            const headerBadge = document.getElementById('header-offline-badge');
            if (headerOfflineCount && mobileOfflineCount) {
                mobileOfflineCount.textContent = headerOfflineCount.textContent;
            }
            if (mobileOfflineBtn && headerBadge) {
                mobileOfflineBtn.style.display = (headerBadge.style.display !== 'none') ? 'flex' : 'none';
            }

            // Sync live players count
            const headerPlayers = document.getElementById('header-players-count');
            const mobileLiveSub = document.getElementById('mobile-live-count-sub');
            if (headerPlayers && mobileLiveSub) {
                mobileLiveSub.textContent = `${headerPlayers.textContent} active`;
            }

            // Sync DB synced time
            const headerDbTime = document.getElementById('header-db-last-refresh-time');
            const mobileDbInfo = document.getElementById('mobile-db-synced-info');
            if (headerDbTime && mobileDbInfo) {
                mobileDbInfo.textContent = '🕒 DB: ' + headerDbTime.textContent;
            }
        }

        function closeMobileActionDrawer() {
            const drawer = document.getElementById('mobile-action-drawer');
            if (drawer) {
                drawer.classList.remove('active');
                document.body.style.overflow = '';
            }
        }

        function selectMobilePlaylistType(type) {
            setSitePlaylistTypeFilter(type);
            document.querySelectorAll('[data-mobile-playlist-type]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mobilePlaylistType === type);
            });
        }

        async function fetchPortalEpgData(forceRefresh = false) {
            const now = Date.now();
            if (!forceRefresh && portalEpgCache && (now - portalEpgLastFetch < 300000)) {
                return portalEpgCache;
            }
            if (portalEpgLoadingPromise) {
                return portalEpgLoadingPromise;
            }
            portalEpgLoadingPromise = (async () => {
                try {
                    const urlParams = new URLSearchParams(window.location.search);
                    const user = urlParams.get('user') || currentUser || '';
                    let url = getApiUrl('api/epg');
                    if (user && !url.includes('user=')) {
                        url += (url.includes('?') ? '&' : '?') + `user=${encodeURIComponent(user)}`;
                    }
                    const res = await fetch(url);
                    if (res.ok) {
                        const data = await res.json();
                        if (Array.isArray(data)) {
                            portalEpgCache = data;
                            portalEpgLastFetch = Date.now();
                            return data;
                        }
                    }
                } catch (err) {
                    console.warn('Failed to load EPG data for TV guide:', err);
                } finally {
                    portalEpgLoadingPromise = null;
                }
                return portalEpgCache || [];
            })();
            return portalEpgLoadingPromise;
        }

        function parseAnyDate(dStr) {
            if (!dStr) return null;
            if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr;
            const str = String(dStr).trim();
            if (!str) return null;

            const xmltvMatch = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
            if (xmltvMatch && !str.includes('-') && !str.includes(':')) {
                const y = parseInt(xmltvMatch[1], 10);
                const m = parseInt(xmltvMatch[2], 10) - 1;
                const d = parseInt(xmltvMatch[3], 10);
                const h = parseInt(xmltvMatch[4], 10);
                const min = parseInt(xmltvMatch[5], 10);
                const s = parseInt(xmltvMatch[6], 10);
                return new Date(Date.UTC(y, m, d, h, min, s));
            }

            const sqlMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
            if (sqlMatch) {
                const y = parseInt(sqlMatch[1], 10);
                const m = parseInt(sqlMatch[2], 10) - 1;
                const d = parseInt(sqlMatch[3], 10);
                const h = parseInt(sqlMatch[4], 10);
                const min = parseInt(sqlMatch[5], 10);
                const s = sqlMatch[6] ? parseInt(sqlMatch[6], 10) : 0;
                return new Date(Date.UTC(y, m, d, h, min, s));
            }

            if (str.includes('T')) {
                const isoStr = (str.endsWith('Z') || str.includes('+') || str.includes('-')) ? str : str + 'Z';
                const d = new Date(isoStr);
                if (!isNaN(d.getTime())) return d;
            }

            const parsed = new Date(str);
            return isNaN(parsed.getTime()) ? null : parsed;
        }

        function formatDisplayTime(dt) {
            if (!dt) return '--:--';
            return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        }

        function formatDisplayDate(dt) {
            if (!dt) return '';
            return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        function formatTimeRange(st, sp) {
            if (!st && !sp) return '24/7 Live Stream';
            if (st && !sp) return `${formatDisplayDate(st)}, ${formatDisplayTime(st)}`;
            if (!st && sp) return `Until ${formatDisplayDate(sp)}, ${formatDisplayTime(sp)}`;

            const stDate = formatDisplayDate(st);
            const spDate = formatDisplayDate(sp);
            const stTime = formatDisplayTime(st);
            const spTime = formatDisplayTime(sp);

            if (stDate === spDate) {
                return `${stDate}, ${stTime} – ${spTime}`;
            }
            return `${stDate}, ${stTime} – ${spDate}, ${spTime}`;
        }

        function jumpPortalTimeline(hoursAhead, btn) {
            const el = document.querySelector('#portal-tvguide-container .tv-guide-timeline-container');
            if (!el) return;
            const pxPerHour = 320; // 2 slots * 160px
            const targetScroll = Math.max(0, hoursAhead * pxPerHour);
            el.scrollTo({ left: targetScroll, behavior: 'smooth' });
            if (btn && btn.parentElement) {
                btn.parentElement.querySelectorAll('.jump-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            }
        }

        function renderPortalChannels() {
            const grid = document.getElementById('portal-channels-grid');
            const tvGuideContainer = document.getElementById('portal-tvguide-container');
            const countEl = document.getElementById('portal-channel-count');
            if (!grid) return;

            updateOfflineVisibility();

            const streams = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData.streams : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData.streams : [];
            let filtered = [];

            const isOfflineFilter = portalActiveProvider === '__OFFLINE__' || portalActiveCategory === '__OFFLINE__';

            streams.forEach((s, originalIndex) => {
                const name = (s.name || '').toLowerCase();
                const cat = (s.category || 'General').trim();
                const catLower = cat.toLowerCase();
                const url = (s.url || '').toLowerCase();
                const prov = getStreamProvider(s);
                const isOffline = Boolean(s.offline || s.is_offline);

                if (isOfflineFilter) {
                    if (!isOffline) return;
                } else if (portalGroupBy === 'provider') {
                    if (portalActiveProvider !== 'ALL' && prov !== portalActiveProvider) {
                        return;
                    }
                } else {
                    if (portalActiveCategory !== 'ALL' && cat !== portalActiveCategory) {
                        return;
                    }
                }

                if (portalSearchQuery) {
                    if (!name.includes(portalSearchQuery) && !catLower.includes(portalSearchQuery) && !url.includes(portalSearchQuery) && !prov.toLowerCase().includes(portalSearchQuery)) {
                        return;
                    }
                }

                filtered.push({ stream: s, index: originalIndex, provider: prov });
            });

            if (countEl) {
                countEl.textContent = `${filtered.length} Channel${filtered.length === 1 ? '' : 's'}`;
            }

            if (portalViewMode === 'timeline') {
                grid.style.display = 'none';
                if (tvGuideContainer) {
                    tvGuideContainer.style.display = 'block';
                    renderPortalTvGuide(filtered);
                }
                return;
            } else {
                grid.style.display = 'grid';
                if (tvGuideContainer) tvGuideContainer.style.display = 'none';
            }

            if (filtered.length === 0) {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; color: var(--muted); background: #f8fafc; border: 1px dashed var(--line); border-radius: 12px;">
                        <div style="font-size: 32px; margin-bottom: 8px;">🔍</div>
                        <div style="font-size: 15px; font-weight: 700; color: var(--ink);">No channels match criteria</div>
                        <div style="font-size: 13px; margin-top: 4px;">Try another provider or category filter or search keyword.</div>
                    </div>
                `;
                return;
            }

            // If arranged by provider and showing ALL, group into provider sections!
            if (portalGroupBy === 'provider' && portalActiveProvider === 'ALL' && !portalSearchQuery) {
                const byProvider = {};
                filtered.forEach(item => {
                    if (!byProvider[item.provider]) byProvider[item.provider] = [];
                    byProvider[item.provider].push(item);
                });

                const sortedProvNames = Object.keys(byProvider).sort((a, b) => {
                    return (PROVIDER_SORT_ORDER[a] || 99) - (PROVIDER_SORT_ORDER[b] || 99);
                });

                let sectionsHtml = '';
                sortedProvNames.forEach(pName => {
                    const items = byProvider[pName];
                    const cardsHtml = items.map(item => renderChannelCardHtml(item.stream, item.index, item.provider, { inProviderSection: true })).join('');
                    sectionsHtml += `
                        <div style="grid-column: 1 / -1; margin-top: 14px; margin-bottom: 4px;">
                            <div class="provider-section-header">
                                <span style="display:flex;align-items:center;gap:8px;">${escapeHtml(providerDisplayLabel(pName))}</span>
                                <span class="provider-section-count">${items.length} Channels</span>
                            </div>
                        </div>
                        ${cardsHtml}
                    `;
                });
                grid.innerHTML = sectionsHtml;
            } else {
                let cardsHtml = filtered.map(item => renderChannelCardHtml(item.stream, item.index, item.provider)).join('');
                grid.innerHTML = cardsHtml;
            }
        }

        function renderPortalTvGuide(filtered) {
            const container = document.getElementById('portal-tvguide-container');
            if (!container) return;

            if (!portalEpgCache) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 48px 20px; background: #ffffff; border: 1px solid var(--line); border-radius: 12px; color: var(--muted);">
                        <div style="font-size: 28px; margin-bottom: 10px;">⏳</div>
                        <div style="font-size: 15px; font-weight: 700; color: var(--ink);">Loading TV Guide Schedule...</div>
                        <div style="font-size: 12px; margin-top: 4px;">Synchronizing 24-hour electronic programming lineup</div>
                    </div>
                `;
                fetchPortalEpgData().then(() => {
                    if (portalViewMode === 'timeline') {
                        renderPortalTvGuide(filtered);
                    }
                });
                return;
            }

            if (!filtered || filtered.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px 20px; color: var(--muted); background: #f8fafc; border: 1px dashed var(--line); border-radius: 12px;">
                        <div style="font-size: 32px; margin-bottom: 8px;">🔍</div>
                        <div style="font-size: 15px; font-weight: 700; color: var(--ink);">No channels match criteria</div>
                        <div style="font-size: 13px; margin-top: 4px;">Try another provider or category filter or search keyword.</div>
                    </div>
                `;
                return;
            }

            // Build lookup map for EPG channels
            const epgMap = {};
            (portalEpgCache || []).forEach(ec => {
                if (ec.url) epgMap[ec.url] = ec;
                if (typeof ec.index === 'number') epgMap['idx_' + ec.index] = ec;
                if (ec.name) epgMap['name_' + ec.name] = ec;
            });

            const now = new Date();
            const baseTime = new Date(now);
            baseTime.setMinutes(baseTime.getMinutes() < 30 ? 0 : 30, 0, 0);

            const numHours = 24;
            const slotDurationMin = 30;
            const numSlots = numHours * (60 / slotDurationMin); // 48 slots
            const slotWidthPx = 160;

            const slots = [];
            for (let i = 0; i < numSlots; i++) {
                const sTime = new Date(baseTime.getTime() + i * slotDurationMin * 60000);
                const isCurrent = (now >= sTime && now < new Date(sTime.getTime() + slotDurationMin * 60000));
                let dayTag = '';
                if (i === 0) {
                    dayTag = 'Today';
                } else if (sTime.getHours() === 0 && sTime.getMinutes() === 0) {
                    dayTag = sTime.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
                }
                slots.push({
                    time: sTime,
                    label: sTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                    dayTag: dayTag,
                    isCurrent: isCurrent
                });
            }

            const windowStart = baseTime.getTime();
            const windowEnd = baseTime.getTime() + numSlots * slotDurationMin * 60000;

            let html = `
                <div class="tv-guide-jump-bar">
                    <span class="jump-title">⏱ Quick Jump (24h):</span>
                    <button type="button" class="jump-btn active" onclick="jumpPortalTimeline(0, this)">📍 Now</button>
                    <button type="button" class="jump-btn" onclick="jumpPortalTimeline(3, this)">+3h</button>
                    <button type="button" class="jump-btn" onclick="jumpPortalTimeline(6, this)">+6h</button>
                    <button type="button" class="jump-btn" onclick="jumpPortalTimeline(12, this)">+12h</button>
                    <button type="button" class="jump-btn" onclick="jumpPortalTimeline(18, this)">+18h</button>
                    <button type="button" class="jump-btn" onclick="jumpPortalTimeline(24, this)">Tomorrow</button>
                    <button type="button" class="jump-btn" onclick="fetchPortalEpgData(true).then(() => renderPortalTvGuide(filtered))" style="margin-left: auto; background: #f8fafc;" title="Refresh EPG Lineup">🔄 Reload EPG</button>
                </div>
                <div class="tv-guide-timeline-container">
                    <div class="tv-guide-header-row">
                        <div class="tv-guide-channel-header-cell">
                            <span>Channels (${filtered.length})</span>
                            <span style="font-size: 0.65rem; color: var(--accent); font-weight: 700;">24H GUIDE</span>
                        </div>
                        <div class="tv-guide-time-slots">
                            ${slots.map(s => `
                                <div class="tv-guide-time-slot ${s.isCurrent ? 'current-slot' : ''}">
                                    ${s.dayTag ? `<span class="slot-day-tag">${s.dayTag}</span>` : ''}
                                    <span class="slot-time-text">${s.isCurrent ? '🔴 ' : ''}${s.label}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
            `;

            filtered.forEach(item => {
                const s = item.stream;
                const originalIndex = item.index;
                const prov = item.provider;
                const isOffline = Boolean(s.offline || s.is_offline);
                const isActive = (portalActiveIndex === originalIndex);

                const epgChan = epgMap[s.url] || epgMap['idx_' + originalIndex] || epgMap['name_' + s.name] || {};
                const programmes = epgChan.programmes || [];

                const nameText = s.name || `Channel ${originalIndex + 1}`;
                const catText = (s.category || 'General').trim();
                const provBadge = `<span class="provider-tag">${escapeHtml(prov)}</span>`;

                let logoHtml = '';
                if (s.logo) {
                    const safeSrc = safeLogoUrl(s.logo);
                    logoHtml = `<img class="tv-guide-channel-logo" src="${escapeHtml(safeSrc)}" alt="${escapeHtml(nameText)}" onerror="this.outerHTML='<div class=\\'tv-guide-channel-logo\\' style=\\'display:flex;align-items:center;justify-content:center;font-size:16px;\\'>📺</div>'">`;
                } else {
                    const initial = nameText.trim().charAt(0).toUpperCase() || '📺';
                    logoHtml = `<div class="tv-guide-channel-logo" style="display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--accent);">${escapeHtml(initial)}</div>`;
                }

                let progBlocks = [];
                if (programmes && programmes.length > 0) {
                    const validProgs = programmes
                        .map(p => {
                            const st = parseAnyDate(p.start);
                            const sp = parseAnyDate(p.stop);
                            return { ...p, startDate: st, stopDate: sp };
                        })
                        .filter(p => p.startDate && p.stopDate && p.stopDate.getTime() > windowStart && p.startDate.getTime() < windowEnd)
                        .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

                    let cursorMs = windowStart;
                    validProgs.forEach(p => {
                        let stMs = Math.max(windowStart, p.startDate.getTime());
                        let spMs = Math.min(windowEnd, p.stopDate.getTime());

                        if (stMs > cursorMs + 60000) {
                            const gapMin = (stMs - cursorMs) / 60000;
                            const gapWidthPx = Math.max(30, Math.round((gapMin / slotDurationMin) * slotWidthPx) - 6);
                            progBlocks.push({
                                title: 'Scheduled Programming',
                                desc: 'Broadcast lineup',
                                timeStr: formatTimeRange(new Date(cursorMs), new Date(stMs)),
                                widthPx: gapWidthPx,
                                isLive: (now.getTime() >= cursorMs && now.getTime() < stMs),
                                isFiller: true
                            });
                            cursorMs = stMs;
                        }

                        if (stMs < cursorMs) {
                            stMs = cursorMs;
                        }

                        if (spMs > stMs) {
                            const durMin = Math.max(10, (spMs - stMs) / 60000);
                            const widthPx = Math.max(80, Math.round((durMin / slotDurationMin) * slotWidthPx) - 6);
                            const isLive = (now >= p.startDate && now <= p.stopDate);

                            progBlocks.push({
                                title: p.title || nameText,
                                desc: p.desc || '',
                                timeStr: formatTimeRange(p.startDate, p.stopDate),
                                widthPx: widthPx,
                                isLive: isLive,
                                isFiller: false
                            });
                            cursorMs = spMs;
                        }
                    });

                    if (cursorMs < windowEnd - 60000) {
                        const remMin = (windowEnd - cursorMs) / 60000;
                        const remWidthPx = Math.max(40, Math.round((remMin / slotDurationMin) * slotWidthPx) - 6);
                        progBlocks.push({
                            title: 'Upcoming Programming',
                            desc: 'Continuous scheduled lineup',
                            timeStr: formatTimeRange(new Date(cursorMs), new Date(windowEnd)),
                            widthPx: remWidthPx,
                            isLive: false,
                            isFiller: true
                        });
                    }
                }

                if (progBlocks.length === 0) {
                    const blocksDef = [
                        { title: `${nameText} (Live)`, desc: 'Continuous streaming broadcast.', durMin: 120, isLive: true },
                        { title: 'Prime Time Broadcast Lineup', desc: 'Featured series & episodes.', durMin: 240, isLive: false },
                        { title: 'Overnight Lineup', desc: 'Continuous network programming.', durMin: 360, isLive: false },
                        { title: 'Daytime Programming', desc: 'Scheduled broadcast series.', durMin: 360, isLive: false },
                        { title: 'Evening Entertainment Lineup', desc: 'Upcoming schedule & continuous feed.', durMin: 360, isLive: false }
                    ];

                    let cursorMs = windowStart;
                    blocksDef.forEach((b, idx) => {
                        let bEnd = (idx === blocksDef.length - 1) ? windowEnd : Math.min(windowEnd, cursorMs + b.durMin * 60000);
                        if (bEnd > cursorMs) {
                            const actualDurMin = (bEnd - cursorMs) / 60000;
                            const wPx = Math.max(90, Math.round((actualDurMin / slotDurationMin) * slotWidthPx) - 6);
                            progBlocks.push({
                                title: b.title,
                                desc: b.desc,
                                timeStr: formatTimeRange(new Date(cursorMs), new Date(bEnd)),
                                widthPx: wPx,
                                isLive: b.isLive,
                                isFiller: false
                            });
                            cursorMs = bEnd;
                        }
                    });
                }

                html += `
                    <div class="tv-guide-channel-row ${isActive ? 'is-active-row' : ''}" data-index="${originalIndex}">
                        <div class="tv-guide-channel-info-cell" onclick="playPortalChannel(${originalIndex})" title="Click to watch ${escapeHtml(nameText)}">
                            ${logoHtml}
                            <div class="tv-guide-channel-meta">
                                <div class="tv-guide-channel-name">${escapeHtml(nameText)}</div>
                                <div class="tv-guide-channel-sub">
                                    ${provBadge}
                                    <span style="font-size:10px; color:var(--text-secondary);">${escapeHtml(catText)}</span>
                                </div>
                                ${scheduleSelectHtml(s, originalIndex)}
                            </div>
                        </div>
                        <div class="tv-guide-programs-track">
                            ${progBlocks.map(pb => `
                                <div class="tv-guide-program-block ${pb.isLive ? 'is-live' : ''} ${pb.isFiller ? 'filler-block' : ''}" style="width: ${pb.widthPx}px;" onclick="playPortalChannel(${originalIndex})" title="Watch ${escapeHtml(nameText)}: ${escapeHtml(pb.title)}">
                                    <div>
                                        <div class="tv-prog-title">${escapeHtml(pb.title)}</div>
                                        <div class="tv-prog-meta">
                                            <span class="tv-prog-time">🕒 ${pb.timeStr}</span>
                                            ${pb.isLive ? '<span class="tv-prog-badge-live">● ON AIR</span>' : ''}
                                        </div>
                                    </div>
                                    <div class="tv-prog-meta" style="margin-top:auto;">
                                        <span style="font-size:10px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:65%;">${escapeHtml(pb.desc)}</span>
                                        <button type="button" class="tv-prog-play-btn" onclick="event.stopPropagation(); playPortalChannel(${originalIndex})">
                                            <span>▶</span> ${pb.isLive ? 'Watch' : 'Play'}
                                        </button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });

            html += `</div>`;
            container.innerHTML = html;
        }

        function updateHeroPreviewInfo(index, isAutoPlay = false) {
            const streams = playlistData.streams || [];
            if (index < 0 || index >= streams.length) return;

            const stream = streams[index];
            const titleEl = document.getElementById('hero-channel-title');
            const subEl = document.getElementById('hero-channel-sub');
            const placeholderTitle = document.getElementById('hero-placeholder-title');
            const categoryTagEl = document.getElementById('hero-category-tag');

            const provName = getStreamProvider(stream);
            if (titleEl) titleEl.textContent = stream.name || `Channel ${index + 1}`;
            if (subEl) subEl.textContent = `${provName} • ${stream.category || 'General'} • ${stream.type === 'youtube_embed' ? 'YouTube Stream' : 'Live Web Feed'}`;
            if (placeholderTitle) placeholderTitle.textContent = `Watch ${stream.name || 'Live'}`;
            if (categoryTagEl) categoryTagEl.textContent = `${provName} • ${currentSitePlaylistType === 'all' ? 'All Channels' : currentSitePlaylistType.toUpperCase()}`;
        }

        function playPortalChannel(index) {
            const streams = playlistData.streams || [];
            if (index < 0 || index >= streams.length) return;

            portalActiveIndex = index;
            const stream = streams[index];

            updateHeroPreviewInfo(index, true);

            const iframe = document.getElementById('portal-hero-iframe');
            const placeholder = document.getElementById('portal-hero-placeholder');
            const playPauseBtn = document.getElementById('btn-portal-playpause');
            const playIcon = document.getElementById('hero-playpause-icon');
            const playText = document.getElementById('hero-playpause-text');

            if (iframe) {
                const targetUrl = formatTestUrl(stream.url);
                iframe.src = targetUrl;
            }

            if (placeholder) {
                placeholder.style.display = 'none';
            }

            portalIsPlaying = true;
            if (playIcon) playIcon.textContent = '⏸️';
            if (playText) playText.textContent = 'Pause';
            if (playPauseBtn) {
                playPauseBtn.style.background = 'rgba(255, 255, 255, 0.12)';
                playPauseBtn.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }

            document.querySelectorAll('.portal-channel-card').forEach(card => {
                if (parseInt(card.getAttribute('data-index')) === index) {
                    card.classList.add('active');
                } else {
                    card.classList.remove('active');
                }
            });

            document.querySelectorAll('.tv-guide-channel-row').forEach(row => {
                if (parseInt(row.getAttribute('data-index')) === index) {
                    row.classList.add('is-active-row');
                } else {
                    row.classList.remove('is-active-row');
                }
            });

            // The player sits above the channel cards and TV guide; when it's scrolled out of
            // view a click there looks like it did nothing, so bring it back on screen
            const heroCard = document.querySelector('.portal-hero-card');
            if (heroCard) {
                const rect = heroCard.getBoundingClientRect();
                if (window.innerWidth <= 768 || rect.top < 0 || rect.bottom > window.innerHeight) {
                    heroCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        }

        function streamScheduleSlot(s) {
            if (!isStreamTemporary(s)) return 'rotation';
            return isStreamForTempWindow(s, 2) ? '2' : '1';
        }

        function scheduleWindowLabel(n) {
            const prefix = n === 2 ? 'temp-schedule-2-' : 'temp-schedule-';
            const start = document.getElementById(prefix + 'start')?.value;
            const end = document.getElementById(prefix + 'end')?.value;
            return start && end ? `Window ${n} (${start}–${end})` : `Window ${n}`;
        }

        function scheduleSelectHtml(s, index) {
            const slot = streamScheduleSlot(s);
            const opt = (value, label) => `<option value="${value}" ${slot === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
            // Phones keep 16px selects (iOS zoom guard), so use short labels there: "Win 1 · 05–12".
            const compact = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
            const label = n => compact ? scheduleWindowLabel(n).replace('Window', 'Win').replace(/\((.*)\)/, '· $1').replace(/:00/g, '') : scheduleWindowLabel(n);
            return `<select class="tv-guide-schedule-select ${slot === 'rotation' ? '' : 'is-window'}" title="Where this channel plays on the kiosk" onclick="event.stopPropagation()" onchange="setStreamSchedule(${index}, this.value, this)">
                ${opt('rotation', compact ? 'Rotation' : 'Normal rotation')}${opt('1', label(1))}${opt('2', label(2))}
            </select>`;
        }

        // TV guide: move a channel between the normal rotation and temporary Window 1 / 2.
        // It moves the one entry (never a copy) so a channel can't play in both, then saves.
        function applyStreamSchedule(s, target) {
            for (const key of ['schedule_window', 'start_date', 'end_date', 'start_time', 'end_time', 'expires_at', 'temporary', 'is_temporary', 'list_type']) {
                delete s[key];
            }
            if (target === 'rotation') {
                s.schedule_type = 'permanent';
                if (String(s.category || '').trim().toLowerCase().startsWith('temp')) delete s.category;
            } else {
                const windowNumber = parseInt(target);
                const prefix = windowNumber === 2 ? 'temp-schedule-2-' : 'temp-schedule-';
                s.schedule_type = 'temporary';
                s.schedule_window = windowNumber;
                s.start_time = document.getElementById(prefix + 'start')?.value || '06:00';
                s.end_time = document.getElementById(prefix + 'end')?.value || '12:00';
                const sDate = document.getElementById(prefix + 'start-date')?.value || '';
                const eDate = document.getElementById(prefix + 'end-date')?.value || '';
                if (sDate) s.start_date = sDate;
                if (eDate) s.end_date = eDate;
            }
        }

        function scheduleTargetLabel(target) {
            return target === 'rotation' ? 'Normal rotation' : scheduleWindowLabel(parseInt(target));
        }

        // Bottom-of-screen confirmation for the schedule pickers (the Studio toast isn't
        // visible from the Watch view)
        function showScheduleNotice(text, isError = false) {
            let el = document.getElementById('schedule-notice');
            if (!el) {
                el = document.createElement('div');
                el.id = 'schedule-notice';
                el.setAttribute('role', 'status');
                document.body.appendChild(el);
            }
            el.className = 'schedule-notice' + (isError ? ' is-error' : '');
            el.textContent = text;
            el.hidden = false;
            clearTimeout(el._hideTimer);
            el._hideTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 4000);
        }

        // Returns whether the save went through (savePlaylist clears isFormModified on success)
        async function saveScheduleChange(selectEl) {
            isFormModified = true;
            if (selectEl) selectEl.disabled = true;
            renderCategorizedGrid();
            renderTemporaryChannelsList();
            await savePlaylist(false, { stayInPlace: true });
            renderPortalChannels();
            return !isFormModified;
        }

        async function setStreamSchedule(index, target, selectEl) {
            const s = (playlistData.streams || [])[index];
            if (!s) return;
            const name = s.name || `Channel ${index + 1}`;
            if (streamScheduleSlot(s) === target) {
                showScheduleNotice(`${name} is already in ${scheduleTargetLabel(target)}`);
                return;
            }
            applyStreamSchedule(s, target);
            const saved = await saveScheduleChange(selectEl);
            showScheduleNotice(saved
                ? `✓ ${name} moved to ${scheduleTargetLabel(target)} · saved`
                : `✗ ${name} not saved. Check Studio for an error, then click Save`, !saved);
        }

        // Watch search: provider channels matching the query that aren't in the playlist yet,
        // each with an "Add to…" picker (normal rotation / Window 1 / Window 2)
        let portalProviderResults = [];
        let portalProviderSearchTimer = null;

        function searchPortalProviders(query) {
            const panel = document.getElementById('portal-provider-results');
            if (!panel) return;
            clearTimeout(portalProviderSearchTimer);
            if (!query || query.length < 2) {
                panel.innerHTML = '';
                portalProviderResults = [];
                return;
            }
            portalProviderSearchTimer = setTimeout(async () => {
                panel.innerHTML = `<div class="portal-provider-head">From your providers</div><div class="portal-provider-empty">Searching providers for "${escapeHtml(query)}"…</div>`;
                try {
                    const res = await fetch(getApiUrl(`api/channels/search?q=${encodeURIComponent(query)}`));
                    const data = await safeParseJson(res);
                    if (portalSearchQuery !== query) return; // a newer search is running
                    if (!Array.isArray(data)) throw new Error(data && data.error || 'search failed');
                    const inPlaylist = new Set((playlistData.streams || []).map((s) => s && s.url));
                    portalProviderResults = data.filter((ch) => ch && ch.url && !inPlaylist.has(ch.url)).slice(0, 40);
                    renderPortalProviderResults(query);
                } catch (err) {
                    panel.innerHTML = `<div class="portal-provider-head">From your providers</div><div class="portal-provider-empty">Provider search failed: ${escapeHtml(err.message)}</div>`;
                }
            }, 400);
        }

        function renderPortalProviderResults(query) {
            const panel = document.getElementById('portal-provider-results');
            if (!panel) return;
            const rows = portalProviderResults.map((ch, i) => `
                <li class="portal-provider-row">
                    <div class="portal-provider-main">
                        <div class="portal-provider-name" title="${escapeHtml(ch.name || '')}">${escapeHtml(ch.name || 'Unnamed channel')}</div>
                        <div class="portal-provider-meta">${escapeHtml([ch.provider, ch.category].filter(Boolean).join(' · '))}${ch.is_playable === false ? ' · <span class="portal-provider-bad">failed last check</span>' : ''}</div>
                    </div>
                    <select class="tv-guide-schedule-select" title="Add this channel to the playlist" onchange="addProviderChannel(${i}, this.value, this)">
                        <option value="" selected disabled>Add to…</option>
                        <option value="rotation">Normal rotation</option>
                        <option value="1">${escapeHtml(scheduleWindowLabel(1))}</option>
                        <option value="2">${escapeHtml(scheduleWindowLabel(2))}</option>
                    </select>
                </li>`).join('');
            panel.innerHTML = `<div class="portal-provider-head">From your providers <span>${portalProviderResults.length ? `${portalProviderResults.length} not in your playlist` : ''}</span></div>`
                + (rows ? `<ul class="portal-provider-list">${rows}</ul>` : `<div class="portal-provider-empty">No provider channels match "${escapeHtml(query)}" that aren't already in your playlist.</div>`);
        }

        async function addProviderChannel(i, target, selectEl) {
            const ch = portalProviderResults[i];
            if (!ch || !target) return;
            const isYt = ch.url.includes('youtube.com') || ch.url.includes('youtu.be');
            const s = { url: ch.url, type: isYt ? 'youtube_embed' : 'generic' };
            if (ch.name) s.name = ch.name;
            if (ch.category) s.category = ch.category;
            if (ch.logo) s.logo = ch.logo;
            if (ch.provider) s.provider = ch.provider;
            applyStreamSchedule(s, target);
            if (!playlistData.streams) playlistData.streams = [];
            playlistData.streams.push(s);
            const saved = await saveScheduleChange(selectEl);
            showScheduleNotice(saved
                ? `✓ ${s.name || 'Channel'} added to ${scheduleTargetLabel(target)} · saved`
                : `✗ ${s.name || 'Channel'} not saved. Check Studio for an error, then click Save`, !saved);
            portalProviderResults.splice(i, 1);
            renderPortalProviderResults(portalSearchQuery);
        }

        function startPortalPlayback() {
            const streams = playlistData.streams || [];
            if (streams.length === 0) return;
            const targetIndex = portalActiveIndex >= 0 ? portalActiveIndex : 0;
            playPortalChannel(targetIndex);
        }

        function portalTogglePlayPause() {
            const streams = playlistData.streams || [];
            if (streams.length === 0) return;

            const iframe = document.getElementById('portal-hero-iframe');
            const placeholder = document.getElementById('portal-hero-placeholder');
            const playPauseBtn = document.getElementById('btn-portal-playpause');
            const playIcon = document.getElementById('hero-playpause-icon');
            const playText = document.getElementById('hero-playpause-text');

            if (portalIsPlaying) {
                if (iframe) iframe.src = 'about:blank';
                if (placeholder) placeholder.style.display = 'flex';
                portalIsPlaying = false;
                if (playIcon) playIcon.textContent = '▶';
                if (playText) playText.textContent = 'Play';
                if (playPauseBtn) {
                    playPauseBtn.style.background = 'var(--accent-color)';
                    playPauseBtn.style.borderColor = 'var(--accent-color)';
                }
            } else {
                startPortalPlayback();
            }
        }

        function getStreamProvider(s) {
            if (!s) return 'Unknown';
            if (s.provider && s.provider.trim() && !['IPTV', 'Live TV', 'Stream'].includes(s.provider.trim())) {
                return s.provider.trim();
            }
            const u = (s.url || '').toLowerCase();
            if (u.includes('tubi.io') || u.includes('tubitv.com')) return 'Tubi';
            if (u.includes('pluto.tv') || u.includes('jmp2.uk')) return 'Pluto TV';
            if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
            if (s.category && s.category.trim()) return s.category.trim();
            return 'Other';
        }

        // Canonical subscription key for anti-collision (mirrors stream_iptv/anti_collision.py):
        // URL first, then normalized label, so "Tubi"/"Tubi TV" etc. are one provider.
        function getStreamSubscriptionKey(s) {
            if (!s) return 'Unknown';
            const u = (s.url || '').toLowerCase();
            const urlRules = [
                [['tubi.io', 'tubitv.com', 'tubi.video'], 'Tubi TV'],
                [['pluto.tv', 'jmp2.uk'], 'Pluto TV'],
                [['youtube.com', 'youtu.be', 'googlevideo.com'], 'YouTube'],
            ];
            for (const [needles, canon] of urlRules) {
                if (needles.some(n => u.includes(n))) return canon;
            }
            const label = String(s.provider || '').replace(/[^\w\s.:-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!['', 'iptv', 'live tv', 'stream', 'unknown', 'other', 'direct'].includes(label)) {
                const labelRules = [['primary provider', 'Primary Provider'],
                                    ['tubi', 'Tubi TV'], ['pluto', 'Pluto TV'], ['youtube', 'YouTube']];
                for (const [needle, canon] of labelRules) {
                    if (label.includes(needle)) return canon;
                }
                return String(s.provider).trim();
            }
            try { const h = new URL(s.url).host.toLowerCase(); if (h) return h; } catch (e) {}
            if (s.category && s.category.trim()) return s.category.trim();
            return 'Other';
        }

        function portalPrevChannel() {
            const streams = playlistData.streams || [];
            if (streams.length === 0) return;
            const curProv = portalActiveIndex >= 0 && streams[portalActiveIndex] ? getStreamSubscriptionKey(streams[portalActiveIndex]) : '';

            let attempts = 0;
            let prevIdx = (portalActiveIndex - 1 + streams.length) % streams.length;
            let firstDiffProvIdx = -1;

            while (attempts < streams.length) {
                if (prevIdx !== portalActiveIndex) {
                    if (getStreamSubscriptionKey(streams[prevIdx]) !== curProv) {
                        firstDiffProvIdx = prevIdx;
                        break;
                    }
                }
                prevIdx = (prevIdx - 1 + streams.length) % streams.length;
                attempts++;
            }

            let newIndex = firstDiffProvIdx !== -1 ? firstDiffProvIdx : (portalActiveIndex <= 0 ? streams.length - 1 : portalActiveIndex - 1);
            playPortalChannel(newIndex);
        }

        function portalNextChannel() {
            const streams = playlistData.streams || [];
            if (streams.length === 0) return;
            const curProv = portalActiveIndex >= 0 && streams[portalActiveIndex] ? getStreamSubscriptionKey(streams[portalActiveIndex]) : '';

            let attempts = 0;
            let nextIdx = (portalActiveIndex + 1) % streams.length;
            let firstDiffProvIdx = -1;

            while (attempts < streams.length) {
                if (nextIdx !== portalActiveIndex) {
                    if (getStreamSubscriptionKey(streams[nextIdx]) !== curProv) {
                        firstDiffProvIdx = nextIdx;
                        break;
                    }
                }
                nextIdx = (nextIdx + 1) % streams.length;
                attempts++;
            }

            let newIndex = firstDiffProvIdx !== -1 ? firstDiffProvIdx : ((portalActiveIndex + 1) % streams.length);
            playPortalChannel(newIndex);
        }

        function interleavePlaylistAntiCollision() {
            if (!playlistData || !Array.isArray(playlistData.streams) || playlistData.streams.length <= 2) {
                showToast("Playlist has too few streams to interleave.");
                return;
            }

            const interleave = (list) => {
                const groups = {};
                const firstSeen = {};
                list.forEach((s, i) => {
                    const p = getStreamSubscriptionKey(s);
                    if (!groups[p]) { groups[p] = []; firstSeen[p] = i; }
                    groups[p].push(s);
                });
                const result = [];
                const keys = [];
                let lastP = '';
                while (true) {
                    const available = Object.keys(groups).filter(p => groups[p].length > 0 && p !== lastP);
                    if (available.length === 0) break;
                    available.sort((a, b) => (groups[b].length - groups[a].length) || (firstSeen[a] - firstSeen[b]));
                    const chosen = available[0];
                    result.push(groups[chosen].shift());
                    keys.push(chosen);
                    lastP = chosen;
                }
                // Leftovers: slot into gaps between two different providers
                Object.keys(groups).forEach(p => {
                    while (groups[p].length > 0) {
                        const it = groups[p].shift();
                        let placed = false;
                        for (let pos = 0; pos <= result.length; pos++) {
                            const left = pos > 0 ? keys[pos - 1] : null;
                            const right = pos < result.length ? keys[pos] : null;
                            if (left !== p && right !== p) {
                                result.splice(pos, 0, it); keys.splice(pos, 0, p); placed = true; break;
                            }
                        }
                        if (!placed) { result.push(it); keys.push(p); }
                    }
                });
                // Wrap-around: last -> first must differ (playlist loops)
                if (result.length > 2 && keys[0] === keys[keys.length - 1]) {
                    const k = keys[keys.length - 1];
                    for (let pos = result.length - 2; pos > 0; pos--) {
                        if (keys[pos - 1] !== k && keys[pos] !== k) {
                            result.splice(pos, 0, result.pop()); keys.splice(pos, 0, keys.pop()); break;
                        }
                    }
                }
                return result;
            };

            const streams = playlistData.streams.slice();
            const online = interleave(streams.filter(s => !s.offline));
            const offline = interleave(streams.filter(s => s.offline));
            const result = online.concat(offline);

            let collisions = 0;
            for (let i = 0; i < online.length && online.length > 1; i++) {
                if (getStreamSubscriptionKey(online[i]) === getStreamSubscriptionKey(online[(i + 1) % online.length])) collisions++;
            }

            playlistData.streams = result;
            playlistData.anti_collision_enabled = true;
            const acCheckbox = document.getElementById('anti-collision-enabled');
            if (acCheckbox) acCheckbox.checked = true;
            updateAntiCollisionBadge(true);
            isFormModified = true;
            renderCategorizedGrid();
            showToast(collisions === 0
                ? "🔀 Playlist interleaved by provider! Zero consecutive collisions. Click 'Save Configuration' to persist."
                : `🔀 Interleaved. ${collisions} unavoidable collision(s): one provider has more than half the channels. Click 'Save Configuration' to persist.`);
        }

        function updateAntiCollisionBadge(enabled) {
            const badge = document.getElementById('anti-collision-status-badge');
            if (badge) {
                badge.textContent = enabled ? 'ON' : 'OFF';
                badge.style.background = enabled ? '#fdf4ff' : '#f1f5f9';
                badge.style.color = enabled ? '#a21caf' : '#475569';
                badge.style.borderColor = enabled ? '#f5d0fe' : '#cbd5e1';
            }
            const btnStatus = document.getElementById('anti-collision-btn-status');
            if (btnStatus) {
                btnStatus.textContent = enabled ? 'ON' : 'OFF';
            }
        }

        function onAntiCollisionToggle(checked) {
            if (!playlistData) return;
            playlistData.anti_collision_enabled = checked;
            updateAntiCollisionBadge(checked);
            isFormModified = true;
            showToast(checked ? "🔀 Anti-Collision Interleave enabled." : "⏸️ Anti-Collision Interleave disabled.");
        }

        function portalFullscreen() {
            const wrap = document.querySelector('.hero-player-wrap');
            if (!wrap) return;
            if (!document.fullscreenElement) {
                if (wrap.requestFullscreen) {
                    wrap.requestFullscreen();
                } else if (wrap.webkitRequestFullscreen) {
                    wrap.webkitRequestFullscreen();
                } else if (wrap.msRequestFullscreen) {
                    wrap.msRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                }
            }
        }

        function portalOpenNewTab() {
            const streams = playlistData.streams || [];
            if (portalActiveIndex >= 0 && portalActiveIndex < streams.length) {
                testCardStream(streams[portalActiveIndex].url, streams[portalActiveIndex].name || '');
            } else if (streams.length > 0) {
                testCardStream(streams[0].url, streams[0].name || '');
            }
        }

        let playlistData = { rotation_interval_seconds: 900, browser_channel: '', streams: [] };
        window.playlistData = playlistData;
        let currentSitePlaylistType = 'all';

        function updateSitePlaylistFilterButtons() {
            const statusEl = document.getElementById('sitePlaylistFilterStatus');
            const categoryTagEl = document.getElementById('hero-category-tag');
            const label = currentSitePlaylistType === 'all' ? 'All' : currentSitePlaylistType === 'both' ? 'Both' : currentSitePlaylistType.charAt(0).toUpperCase() + currentSitePlaylistType.slice(1);
            if (statusEl) statusEl.textContent = label;
            if (categoryTagEl) categoryTagEl.textContent = `Category: ${label}`;

            document.querySelectorAll('[data-site-playlist-type]').forEach(btn => {
                const active = btn.dataset.sitePlaylistType === currentSitePlaylistType;
                btn.classList.toggle('active', active);
                btn.style.background = active ? '#dbeafe' : '';
                btn.style.borderColor = active ? '#93c5fd' : '';
                btn.style.color = active ? '#1d4ed8' : '';
            });

            document.querySelectorAll('[data-mobile-playlist-type]').forEach(btn => {
                const active = btn.dataset.mobilePlaylistType === currentSitePlaylistType;
                btn.classList.toggle('active', active);
            });
        }

        // URLs/names of channels in Window 1 or 2; Normal rotation leaves out any permanent copy of these
        function getWindowChannelKeys(streams) {
            const key = (s, f) => String((s && s[f]) || '').trim().toLowerCase();
            const list = Array.isArray(streams) ? streams : [];
            const windowStreams = list.filter(s => isStreamTemporary(s));
            const urls = new Set(windowStreams.map(s => key(s, 'url')).filter(Boolean));
            const names = new Set(windowStreams.map(s => key(s, 'name')).filter(Boolean));
            const isNormal = s => !isStreamTemporary(s) && !urls.has(key(s, 'url')) && !names.has(key(s, 'name'));
            return { isNormal, normalCount: list.filter(isNormal).length };
        }

        function setSitePlaylistTypeFilter(type) {
            const allowed = ['all', 'normal', 'permanent', 'temporary', 'both'];
            if (!allowed.includes(type)) type = 'all';
            currentSitePlaylistType = type;
            const url = new URL(window.location.href);
            url.searchParams.set('playlist_type', currentSitePlaylistType);
            window.history.replaceState({}, '', url);
            updateSitePlaylistFilterButtons();
            refreshSitePlaylistData();
        }

        async function refreshSitePlaylistData() {
            try {
                const user = (window.IPTV_CONFIG.currentUser || window.IPTV_CONFIG.adminUser || "admin");
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                // Normal is filtered client-side from the full playlist (it needs the window channels to exclude them)
                const fetchType = currentSitePlaylistType === 'normal' ? 'all' : currentSitePlaylistType;
                const res = await fetch(`${base}api/playlist?user=${encodeURIComponent(user)}&mode=edit&playlist_type=${encodeURIComponent(fetchType)}`);
                const data = await res.json();
                if (data && Array.isArray(data.streams)) {
                    playlistData = data;
                    window.playlistData = playlistData;
                    renderCategorizedGrid();
                    renderPortalView();
                    const totalBadge = document.getElementById('header-total-channels');
                    if (totalBadge) totalBadge.textContent = currentSitePlaylistType === 'normal' ? getWindowChannelKeys(data.streams).normalCount : data.streams.length;
                    const toast = document.getElementById('toast');
                    if (toast) {
                        toast.textContent = `📡 Showing ${currentSitePlaylistType === 'all' ? 'all' : currentSitePlaylistType === 'both' ? 'both permanent and temporary' : currentSitePlaylistType === 'normal' ? 'normal rotation (no Window 1/2 channels)' : currentSitePlaylistType} playlists`; 
                        toast.style.display = 'block';
                        setTimeout(() => { toast.style.display = 'none'; }, 2200);
                    }
                    return;
                }
                throw new Error(data.error || 'Invalid playlist response');
            } catch (err) {
                console.error('Failed to refresh site playlist by type:', err);
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            const params = new URLSearchParams(window.location.search);
            currentSitePlaylistType = ['all', 'normal', 'permanent', 'temporary', 'both'].includes(params.get('playlist_type')) ? params.get('playlist_type') : 'all';
            loadProviderConfig();
            
            // Initialize from JSON script tag
            try {
                playlistData = JSON.parse(document.getElementById('playlist-data').textContent);
                window.playlistData = playlistData;
            } catch (err) {
                console.error("Failed to parse playlist data:", err);
            }
            updateSitePlaylistFilterButtons();
            renderCategorizedGrid();
            initPortalView();
            loadIptvCategories();
            loadPlutoCategories();
            loadTubiCategories();
            updateQuietHoursBadge();
            setInterval(updateQuietHoursBadge, 30000);
            updateTemporaryScheduleBadge();
            setInterval(updateTemporaryScheduleBadge, 30000);
            if (playlistData) {
                const acEnabled = playlistData.anti_collision_enabled !== undefined ? !!playlistData.anti_collision_enabled : true;
                updateAntiCollisionBadge(acEnabled);
                const acCheckbox = document.getElementById('anti-collision-enabled');
                if (acCheckbox) acCheckbox.checked = acEnabled;
            }
            restoreIptvSearchState();
            
            // Modal focusout auto-fetch title
            const editUrlInput = document.getElementById('edit-stream-url');
            if (editUrlInput) {
                editUrlInput.addEventListener('focusout', async () => {
                    const nameInput = document.getElementById('edit-stream-name');
                    if (nameInput && !nameInput.value.trim() && editUrlInput.value.trim()) {
                        const urlVal = editUrlInput.value.trim();
                        try {
                            const response = await fetch(getApiUrl(`api/playlist/get-title?url=${encodeURIComponent(urlVal)}`));
                            if (response.ok) {
                                const data = await response.json();
                                if (data.title && !nameInput.value.trim()) {
                                    nameInput.value = data.title;
                                }
                            }
                        } catch (err) {
                            console.error("Failed to auto-fetch title:", err);
                        }
                    }
                });
            }
        });

        // Track form edits
        window.addEventListener('input', (e) => {
            if (e.target.closest('#channel-modal') || e.target.closest('.global-settings')) {
                isFormModified = true;
            }
        });

        function isStreamTemporary(s) {
            if (!s || typeof s !== 'object') return false;
            const stype = String(s.schedule_type || s.list_type || '').toLowerCase();
            if (stype === 'temporary') return true;
            if (s.temporary === true || s.is_temporary === true) return true;
            const cat = String(s.category || '').trim().toLowerCase();
            if (cat === 'temporary' || cat === 'temp' || cat.startsWith('temp')) return true;
            if (s.start_date || s.end_date || s.start_time || s.end_time || s.expires_at) return true;
            return false;
        }

        function isStreamActiveNow(s) {
            if (!s || typeof s !== 'object') return true;
            if (s.offline || s.is_offline) return false;
            if (s.is_active_now !== undefined) return Boolean(s.is_active_now);
            if (!isStreamTemporary(s)) return true;

            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const nowDateStr = `${yyyy}-${mm}-${dd}`;
            const currentMins = now.getHours() * 60 + now.getMinutes();

            // 1. Expiration check
            if (s.expires_at) {
                try {
                    const exp = new Date(s.expires_at);
                    if (!isNaN(exp.getTime()) && now >= exp) return false;
                } catch (e) {}
            }

            // 2. Date span check
            if (s.start_date && s.start_date.trim()) {
                if (nowDateStr < s.start_date.trim().substring(0, 10)) return false;
            }
            if (s.end_date && s.end_date.trim()) {
                if (nowDateStr > s.end_date.trim().substring(0, 10)) return false;
            }

            // 3. Time of day check (hours)
            if (s.start_time && s.end_time && s.start_time.trim() && s.end_time.trim()) {
                try {
                    const sParts = s.start_time.trim().split(':').map(Number);
                    const eParts = s.end_time.trim().split(':').map(Number);
                    const sMins = (sParts[0] || 0) * 60 + (sParts[1] || 0);
                    const eMins = (eParts[0] || 0) * 60 + (eParts[1] || 0);

                    if (sMins <= eMins) {
                        if (!(currentMins >= sMins && currentMins <= eMins)) return false;
                    } else {
                        // Spans midnight e.g. 22:00 - 06:00
                        if (!(currentMins >= sMins || currentMins <= eMins)) return false;
                    }
                } catch (e) {}
            }

            return true;
        }

        function renderCategorizedGrid() {
            const container = document.getElementById('categorized-grids-container');
            if (!container) return;
            
            const streams = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData.streams : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData.streams : [];
            const totalBadge = document.getElementById('header-total-channels');
            if (totalBadge) totalBadge.textContent = streams.length;
            
            updateOfflineVisibility();
            renderPortalView();

            container.innerHTML = '';

            const isProvMode = studioGroupBy === 'provider';
            const offlineCount = streams.filter(s => s && (s.offline || s.is_offline)).length;
            const offlineBtn = offlineCount > 0 ? `
                <button type="button" class="btn btn-secondary" onclick="openOfflineChannelsModal()" style="padding:4px 10px;font-size:11px;font-weight:700;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;" title="View all channels currently marked offline">🔴 Offline (${offlineCount})</button>
            ` : '';

            const toolbar = document.createElement('div');
            toolbar.style = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:10px 14px;background:#f8fafc;border:1px solid var(--line);border-radius:10px;flex-wrap:wrap;gap:8px;';
            toolbar.innerHTML = `
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-right:2px;">Group Studio Grid:</span>
                    <button type="button" class="btn btn-secondary" onclick="setStudioGroupBy('provider')" style="padding:4px 10px;font-size:11px;font-weight:${isProvMode ? '700' : '500'};background:${isProvMode ? 'var(--accent)' : '#fff'};color:${isProvMode ? '#fff' : 'var(--ink)'};border:1px solid ${isProvMode ? 'var(--accent)' : 'var(--line)'};border-radius:6px;cursor:pointer;">🏷️ By Provider</button>
                    <button type="button" class="btn btn-secondary" onclick="setStudioGroupBy('category')" style="padding:4px 10px;font-size:11px;font-weight:${!isProvMode ? '700' : '500'};background:${!isProvMode ? 'var(--accent)' : '#fff'};color:${!isProvMode ? '#fff' : 'var(--ink)'};border:1px solid ${!isProvMode ? 'var(--accent)' : 'var(--line)'};border-radius:6px;cursor:pointer;">📁 By Category</button>
                    ${offlineBtn}
                </div>
                <button type="button" class="btn btn-secondary" onclick="arrangePlaylistByProviders()" style="padding:4px 12px;font-size:11px;font-weight:700;background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;" title="Permanently order & save active playlist by providers">🔀 Arrange & Save by Provider</button>
            `;
            container.appendChild(toolbar);
            
            // Group streams by provider or category
            const categories = {};
            
            if (streams.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.style = 'text-align: center; padding: 40px; color: var(--text-secondary); background: rgba(255,255,255,0.01); border: 1px solid var(--border-color); border-radius: 12px;';
                emptyMsg.textContent = 'No channels added yet. Click "+ Add Channel" or search the IPTV Database above.';
                container.appendChild(emptyMsg);
                return;
            }
            
            const windowKeys = getWindowChannelKeys(streams);
            streams.forEach((stream, index) => {
                const isTemp = isStreamTemporary(stream);
                const schedType = isTemp ? 'temporary' : (stream.schedule_type || 'permanent').toLowerCase();
                // Filter by top playlist type filter if active
                if (currentSitePlaylistType === 'normal' && !windowKeys.isNormal(stream)) return;
                if (currentSitePlaylistType === 'permanent' && isTemp) return;
                if (currentSitePlaylistType === 'temporary' && !isTemp) return;

                const groupKey = isProvMode ? getStreamProvider(stream) : (stream.category || 'Uncategorized').trim();
                if (!categories[groupKey]) {
                    categories[groupKey] = [];
                }
                categories[groupKey].push({ stream, index });
            });
            
            // Sort group names
            let sortedCategoryNames;
            if (isProvMode) {
                sortedCategoryNames = Object.keys(categories).sort((a, b) => {
                    return (PROVIDER_SORT_ORDER[a] || 99) - (PROVIDER_SORT_ORDER[b] || 99);
                });
            } else {
                sortedCategoryNames = Object.keys(categories).sort((a, b) => {
                    if (a === 'Uncategorized') return 1;
                    if (b === 'Uncategorized') return -1;
                    return a.localeCompare(b);
                });
            }
            
            if (sortedCategoryNames.length === 0) {
                const noMatch = document.createElement('div');
                noMatch.style = 'text-align: center; padding: 40px; color: var(--text-secondary); background: rgba(255,255,255,0.01); border: 1px solid var(--border-color); border-radius: 12px;';
                noMatch.innerHTML = `No channels matching schedule filter "<strong>${escapeHtml(currentSitePlaylistType)}</strong>".`;
                container.appendChild(noMatch);
                return;
            }

            sortedCategoryNames.forEach(catName => {
                const section = document.createElement('div');
                section.className = 'category-section';
                
                const title = document.createElement('div');
                title.className = 'category-title';
                const icon = isProvMode ? '🏷️' : '📂';
                title.innerHTML = `<span>${icon}</span> ${escapeHtml(catName)} <span style="font-size:11px;font-weight:600;color:var(--muted);margin-left:6px;">(${categories[catName].length} channels)</span>`;
                section.appendChild(title);
                
                const grid = document.createElement('div');
                grid.className = 'category-grid';
                
                categories[catName].forEach(({ stream, index }) => {
                    const card = document.createElement('div');
                    const isOffline = Boolean(stream.offline || stream.is_offline);
                    card.className = `channel-card ${isOffline ? 'is-offline' : ''}`;
                    
                    const nameText = stream.name || `Channel ${index + 1}`;
                    const typeClass = stream.type === 'youtube_embed' ? 'youtube' : 'generic';
                    const typeLabel = stream.type === 'youtube_embed' ? 'YouTube' : 'Webpage';
                    let durationText = 'Global';
                    if (stream.duration_seconds) {
                        const totalSec = parseInt(stream.duration_seconds);
                        if (!isNaN(totalSec) && totalSec > 0) {
                            if (totalSec >= 60) {
                                const m = Math.floor(totalSec / 60);
                                const s = totalSec % 60;
                                durationText = s > 0 ? `${m}m ${s}s` : `${m}m`;
                            } else {
                                durationText = `${totalSec}s`;
                            }
                        }
                    }
                    
                    const isTemp = isStreamTemporary(stream);
                    const schedType = isTemp ? 'temporary' : (stream.schedule_type || 'permanent').toLowerCase();
                    const activeNow = isStreamActiveNow(stream);

                    let schedBadge = '';
                    if (isTemp) {
                        let schedDetail = '';
                        if (stream.start_time && stream.end_time) {
                            schedDetail += ` • ⏰ ${stream.start_time}-${stream.end_time}`;
                        }
                        if (stream.start_date || stream.end_date) {
                            schedDetail += ` • 📅 ${stream.start_date || '...'}~${stream.end_date || '...'}`;
                        }
                        const statusDot = activeNow 
                            ? '<span style="color: #16a34a; font-weight: 700; margin-left: 3px;">🟢 Active Now</span>'
                            : '<span style="color: #d97706; font-weight: 700; margin-left: 3px;">⏳ Inactive</span>';
                        schedBadge = `<span class="card-badge" style="background: #fffbeb; color: #b45309; border: 1px solid #fde68a;" title="Temporary stream with time restriction">🕒 Temp${schedDetail} [${statusDot}]</span>`;
                    } else {
                        schedBadge = `<span class="card-badge" style="background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0;" title="Permanent 24/7 stream">📌 Permanent</span>`;
                    }

                    const lastErr = stream.last_error ? escapeHtml(stream.last_error) : '';
                    let offlineBadge = '';
                    let offlineBannerHtml = '';
                    if (isOffline) {
                        offlineBadge = `<span class="card-badge" style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-weight: 700;" title="${lastErr || 'Stream offline'}">🔴 Offline</span>`;
                        offlineBannerHtml = `<div style="font-size: 11px; color: #dc2626; background: #fef2f2; border: 1px solid #fee2e2; border-radius: 6px; padding: 5px 8px; margin: 4px 0; display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;"><span>⚠️ <strong>Error:</strong> ${lastErr || 'Health check failed'}</span>${stream.offline_since ? `<span style="color:#64748b;font-size:10px;">(${escapeHtml(stream.offline_since)})</span>` : ''}</div>`;
                    }

                    card.innerHTML = `
                        <div class="card-header-main" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                            <span class="card-title-text" style="font-weight: 600;">${nameText}</span>
                            <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                                ${offlineBadge}
                                ${schedBadge}
                                <span class="card-badge ${typeClass}">${typeLabel}</span>
                            </div>
                        </div>
                        <div class="card-url-preview" title="${stream.url}">${stream.url}</div>
                        ${offlineBannerHtml}
                        <div class="card-footer">
                            <span class="card-duration">⏱️ ${durationText}</span>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div style="display: flex; gap: 4px;">
                                    <button type="button" class="card-btn" onclick="moveChannel(${index}, -1)" ${index === 0 ? 'disabled' : ''} style="padding: 2px 6px;" title="Move Up">▲</button>
                                    <button type="button" class="card-btn" onclick="moveChannel(${index}, 1)" ${index === streams.length - 1 ? 'disabled' : ''} style="padding: 2px 6px;" title="Move Down">▼</button>
                                </div>
                                <div class="card-actions">
                                    <button type="button" class="card-btn edit" onclick="openEditModal(${index})">✏️ Edit</button>
                                    <button type="button" class="card-btn" onclick="testCardStreamByIndex(${index})" title="Test stream in embedded preview">🔗 Test</button>
                                    <button type="button" class="card-btn remove" onclick="deleteCardStream(${index})">❌ Remove</button>
                                </div>
                            </div>
                        </div>
                    `;
                    
                    grid.appendChild(card);
                });
                
                section.appendChild(grid);
                container.appendChild(section);
            });
        }

        function moveChannel(index, direction) {
            const streams = playlistData.streams || [];
            const targetIndex = index + direction;
            if (targetIndex < 0 || targetIndex >= streams.length) return;
            
            // Swap
            const temp = streams[index];
            streams[index] = streams[targetIndex];
            streams[targetIndex] = temp;
            
            isFormModified = true;
            renderCategorizedGrid();
        }

        function formatTestUrl(rawUrl) {
            if (!rawUrl) return '';
            let url = rawUrl.trim();
            if (url.includes('/player?') && url.includes('url=')) {
                try {
                    const parsed = new URL(url, window.location.href);
                    const extracted = parsed.searchParams.get('url');
                    if (extracted) url = extracted;
                } catch (e) {
                    const match = url.match(/[?&]url=([^&]+)/);
                    if (match) url = decodeURIComponent(match[1]);
                }
            }
            if (url.includes("youtube.com/watch?v=")) {
                const videoId = url.split("watch?v=")[1].split("&")[0];
                return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
            } else if (url.includes("youtu.be/")) {
                const videoId = url.split("youtu.be/")[1].split("?")[0];
                return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
            } else if (url.includes("youtube.com/embed/")) {
                return url;
            }
            return getApiUrl(`player?url=${encodeURIComponent(url)}`);
        }

        let isTestPlayerDocked = false;
        let isTestPlayerMaximized = false;
        let testPlayerPrevRect = null;
        let isDraggingPlayer = false;
        let isResizingPlayer = false;
        let currentTestingChannel = { url: '', name: '' };

        function updateTestPlayerAddButtonState() {
            const addBtns = [
                document.getElementById('test-player-add-btn'),
                document.getElementById('test-player-add-btn-header')
            ];
            const pd = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData : (window.playlistData && Array.isArray(window.playlistData.streams)) ? window.playlistData : null;
            const streams = (pd && Array.isArray(pd.streams)) ? pd.streams : [];
            const exists = streams.some(s => s.url === currentTestingChannel.url);
            addBtns.forEach(btn => {
                if (!btn) return;
                if (exists) {
                    btn.textContent = '✓ In Playlist';
                    btn.style.background = '#059669';
                    btn.style.borderColor = '#10b981';
                    btn.disabled = true;
                    btn.style.cursor = 'default';
                } else {
                    btn.textContent = '+ Add to Playlist';
                    btn.style.background = '#2563eb';
                    btn.style.borderColor = '#3b82f6';
                    btn.disabled = false;
                    btn.style.cursor = 'pointer';
                }
            });
        }

        function addCurrentTestingChannelToPlaylist() {
            if (!currentTestingChannel.url) return;
            addProviderChannelToPlaylist(currentTestingChannel.name, currentTestingChannel.url, currentTestingChannel.category || 'Live TV');
            updateTestPlayerAddButtonState();
        }

        window.addCurrentTestingChannelToPlaylist = addCurrentTestingChannelToPlaylist;
        window.updateTestPlayerAddButtonState = updateTestPlayerAddButtonState;

        function openStandalonePlayer(rawUrl) {
            if (!rawUrl) return;
            const testUrl = formatTestUrl(rawUrl);
            window.open(testUrl, '_blank');
        }
        window.openStandalonePlayer = openStandalonePlayer;

        function openTestPlayer(rawUrl, channelName = '', category = 'Live TV') {
            if (!rawUrl) return;
            currentTestingChannel = { url: rawUrl, name: channelName || 'Channel', category: category || 'Live TV' };
            const testUrl = formatTestUrl(rawUrl);
            const modal = document.getElementById('test-player-modal');
            const iframe = document.getElementById('test-player-iframe');
            const titleEl = document.getElementById('test-player-title');
            const urlEl = document.getElementById('test-player-url');
            const popoutLink = document.getElementById('test-player-popout');
            const card = document.getElementById('test-player-card');

            if (titleEl) {
                titleEl.textContent = channelName ? `Testing: ${channelName}` : 'Stream Test Preview';
            }
            if (urlEl) {
                urlEl.textContent = rawUrl;
                urlEl.title = rawUrl;
            }
            if (popoutLink) {
                popoutLink.href = testUrl;
            }
            if (iframe) {
                iframe.src = testUrl;
            }
            if (modal) {
                modal.classList.add('active', 'floating');
            }
            updateTestPlayerAddButtonState();
            initTestPlayerDragAndResize();

            // Set fixed coordinates on first open so it can be dragged immediately
            if (card && (!card.style.left || !card.style.top || !isTestPlayerDocked)) {
                const cardW = Math.min(620, Math.floor(window.innerWidth * 0.94));
                const leftPos = Math.max(10, Math.floor((window.innerWidth - cardW) / 2));
                const topPos = Math.max(20, Math.floor((window.innerHeight - 440) / 2));
                card.style.position = 'fixed';
                card.style.left = `${leftPos}px`;
                card.style.top = `${topPos}px`;
                card.style.margin = '0';
                card.style.width = `${cardW}px`;
                const centerBtn = document.getElementById('test-player-center-btn');
                if (centerBtn) centerBtn.style.display = 'inline-flex';
            }
        }

        function closeTestPlayer() {
            const modal = document.getElementById('test-player-modal');
            const iframe = document.getElementById('test-player-iframe');
            if (iframe) {
                iframe.src = ''; // Stops audio and video immediately
            }
            if (modal) {
                modal.classList.remove('active', 'floating');
            }
        }

        function setTestPlayerSize(sizeKey) {
            const card = document.getElementById('test-player-card');
            const modal = document.getElementById('test-player-modal');
            if (!card) return;
            if (isTestPlayerMaximized) {
                toggleTestPlayerMaximize();
            }
            let targetW = 620;
            if (sizeKey === 'sm') targetW = 420;
            else if (sizeKey === 'md') targetW = 640;
            else if (sizeKey === 'lg') targetW = 880;

            targetW = Math.min(targetW, Math.floor(window.innerWidth * 0.96));
            card.classList.remove('custom-height');
            card.style.width = `${targetW}px`;
            card.style.maxWidth = `${targetW}px`;
            card.style.height = 'auto';

            if (modal && modal.classList.contains('floating')) {
                const rect = card.getBoundingClientRect();
                if (rect.right > window.innerWidth) {
                    card.style.left = `${Math.max(10, window.innerWidth - targetW - 20)}px`;
                }
                if (rect.bottom > window.innerHeight) {
                    card.style.top = `${Math.max(10, window.innerHeight - card.offsetHeight - 20)}px`;
                }
            }
        }

        function toggleTestPlayerMaximize() {
            const card = document.getElementById('test-player-card');
            const maxBtn = document.getElementById('test-player-max-btn');
            if (!card) return;
            isTestPlayerMaximized = !isTestPlayerMaximized;
            if (isTestPlayerMaximized) {
                testPlayerPrevRect = {
                    width: card.style.width,
                    maxWidth: card.style.maxWidth,
                    height: card.style.height,
                    left: card.style.left,
                    top: card.style.top,
                    right: card.style.right,
                    bottom: card.style.bottom,
                    position: card.style.position
                };
                card.classList.add('is-maximized');
                if (maxBtn) maxBtn.textContent = '🗗 Restore';
            } else {
                card.classList.remove('is-maximized');
                if (testPlayerPrevRect) {
                    card.style.width = testPlayerPrevRect.width || '620px';
                    card.style.maxWidth = testPlayerPrevRect.maxWidth || '94%';
                    card.style.height = testPlayerPrevRect.height || 'auto';
                    card.style.left = testPlayerPrevRect.left || '';
                    card.style.top = testPlayerPrevRect.top || '';
                    card.style.right = testPlayerPrevRect.right || '';
                    card.style.bottom = testPlayerPrevRect.bottom || '';
                    card.style.position = testPlayerPrevRect.position || '';
                }
                if (maxBtn) maxBtn.textContent = '🗖';
            }
        }

        function resetTestPlayerPosition() {
            const card = document.getElementById('test-player-card');
            const modal = document.getElementById('test-player-modal');
            const centerBtn = document.getElementById('test-player-center-btn');
            const dockBtn = document.getElementById('test-player-dock-btn');
            if (!card) return;
            if (isTestPlayerMaximized) toggleTestPlayerMaximize();
            isTestPlayerDocked = false;
            card.classList.remove('custom-height');
            const cardW = Math.min(620, Math.floor(window.innerWidth * 0.94));
            const leftPos = Math.max(10, Math.floor((window.innerWidth - cardW) / 2));
            const topPos = Math.max(20, Math.floor((window.innerHeight - 440) / 2));
            card.style.position = 'fixed';
            card.style.left = `${leftPos}px`;
            card.style.top = `${topPos}px`;
            card.style.right = 'auto';
            card.style.bottom = 'auto';
            card.style.margin = '0';
            card.style.width = `${cardW}px`;
            card.style.maxWidth = '94%';
            card.style.height = 'auto';
            if (modal) {
                modal.classList.add('floating');
                modal.classList.remove('docked');
            }
            if (centerBtn) centerBtn.style.display = 'inline-flex';
            if (dockBtn) {
                dockBtn.textContent = '🗗 Dock';
                dockBtn.title = 'Dock to bottom corner to browse playlist while testing';
            }
        }

        function toggleTestPlayerDock() {
            const modal = document.getElementById('test-player-modal');
            const card = document.getElementById('test-player-card');
            const dockBtn = document.getElementById('test-player-dock-btn');
            const centerBtn = document.getElementById('test-player-center-btn');
            if (!modal || !card) return;
            isTestPlayerDocked = !isTestPlayerDocked;
            if (isTestPlayerDocked) {
                if (isTestPlayerMaximized) toggleTestPlayerMaximize();
                modal.classList.add('docked');
                modal.classList.remove('floating');
                card.classList.remove('custom-height');
                card.style.position = 'fixed';
                card.style.left = 'auto';
                card.style.top = 'auto';
                card.style.right = '24px';
                card.style.bottom = '24px';
                card.style.width = '480px';
                card.style.maxWidth = '92vw';
                card.style.height = 'auto';
                if (centerBtn) centerBtn.style.display = 'inline-flex';
                if (dockBtn) {
                    dockBtn.textContent = '🗖 Center';
                    dockBtn.title = 'Center test window on screen';
                }
            } else {
                resetTestPlayerPosition();
            }
        }

        function initTestPlayerDragAndResize() {
            const card = document.getElementById('test-player-card');
            const header = document.getElementById('test-player-header');
            const grip = document.getElementById('test-player-resize-grip');
            const modal = document.getElementById('test-player-modal');
            const centerBtn = document.getElementById('test-player-center-btn');
            if (!card || !header) return;
            if (header.dataset.dragInit === 'true') return;
            header.dataset.dragInit = 'true';

            let dragStartX = 0, dragStartY = 0, initialLeft = 0, initialTop = 0;
            let resizeStartX = 0, resizeStartY = 0, initialW = 0, initialH = 0;

            // Double-click header to maximize/restore
            header.addEventListener('dblclick', (e) => {
                if (e.target.closest('button, a, input, select, textarea')) return;
                toggleTestPlayerMaximize();
            });

            // Modern PointerEvents for Dragging (Mouse, Touch, Stylus)
            header.addEventListener('pointerdown', onDragPointerDown);

            function onDragPointerDown(e) {
                if (e.target.closest('button, a, input, select, textarea')) return;
                if (isTestPlayerMaximized) return;
                e.preventDefault();

                try {
                    header.setPointerCapture(e.pointerId);
                } catch(err) {}

                isDraggingPlayer = true;
                document.body.classList.add('test-player-drag-active');

                const rect = card.getBoundingClientRect();
                card.style.position = 'fixed';
                card.style.left = `${rect.left}px`;
                card.style.top = `${rect.top}px`;
                card.style.right = 'auto';
                card.style.bottom = 'auto';
                card.style.margin = '0';
                if (modal) {
                    modal.classList.add('floating');
                    modal.classList.remove('docked');
                }
                isTestPlayerDocked = false;
                if (centerBtn) centerBtn.style.display = 'inline-flex';

                dragStartX = e.clientX;
                dragStartY = e.clientY;
                initialLeft = rect.left;
                initialTop = rect.top;

                window.addEventListener('pointermove', onDragPointerMove);
                window.addEventListener('pointerup', onDragPointerUp);
                window.addEventListener('pointercancel', onDragPointerUp);
            }

            function onDragPointerMove(e) {
                if (!isDraggingPlayer) return;
                const dx = e.clientX - dragStartX;
                const dy = e.clientY - dragStartY;
                let newLeft = initialLeft + dx;
                let newTop = initialTop + dy;

                const cardW = card.offsetWidth;
                const cardH = card.offsetHeight;
                newLeft = Math.max(0, Math.min(window.innerWidth - cardW, newLeft));
                newTop = Math.max(0, Math.min(window.innerHeight - cardH, newTop));

                card.style.left = `${newLeft}px`;
                card.style.top = `${newTop}px`;
                card.style.right = 'auto';
                card.style.bottom = 'auto';
            }

            function onDragPointerUp(e) {
                if (!isDraggingPlayer) return;
                isDraggingPlayer = false;
                document.body.classList.remove('test-player-drag-active');
                try {
                    header.releasePointerCapture(e.pointerId);
                } catch(err) {}
                window.removeEventListener('pointermove', onDragPointerMove);
                window.removeEventListener('pointerup', onDragPointerUp);
                window.removeEventListener('pointercancel', onDragPointerUp);
            }

            // Modern PointerEvents for Resizing
            if (grip) {
                grip.addEventListener('pointerdown', onResizePointerDown);

                function onResizePointerDown(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isTestPlayerMaximized) return;

                    try {
                        grip.setPointerCapture(e.pointerId);
                    } catch(err) {}

                    isResizingPlayer = true;
                    document.body.classList.add('test-player-resize-active');

                    const rect = card.getBoundingClientRect();
                    card.style.position = 'fixed';
                    card.style.left = `${rect.left}px`;
                    card.style.top = `${rect.top}px`;
                    card.style.right = 'auto';
                    card.style.bottom = 'auto';
                    card.style.margin = '0';
                    if (modal) {
                        modal.classList.add('floating');
                        modal.classList.remove('docked');
                    }
                    isTestPlayerDocked = false;
                    if (centerBtn) centerBtn.style.display = 'inline-flex';

                    resizeStartX = e.clientX;
                    resizeStartY = e.clientY;
                    initialW = rect.width;
                    initialH = rect.height;

                    window.addEventListener('pointermove', onResizePointerMove);
                    window.addEventListener('pointerup', onResizePointerUp);
                    window.addEventListener('pointercancel', onResizePointerUp);
                }

                function onResizePointerMove(e) {
                    if (!isResizingPlayer) return;
                    const dw = e.clientX - resizeStartX;
                    const dh = e.clientY - resizeStartY;
                    const minW = 320;
                    const maxW = Math.floor(window.innerWidth * 0.98);
                    const minH = 200;
                    const maxH = Math.floor(window.innerHeight * 0.96);

                    const newW = Math.max(minW, Math.min(maxW, initialW + dw));
                    const newH = Math.max(minH, Math.min(maxH, initialH + dh));

                    card.classList.add('custom-height');
                    card.style.width = `${newW}px`;
                    card.style.maxWidth = `${newW}px`;
                    card.style.height = `${newH}px`;
                }

                function onResizePointerUp(e) {
                    if (!isResizingPlayer) return;
                    isResizingPlayer = false;
                    document.body.classList.remove('test-player-resize-active');
                    try {
                        grip.releasePointerCapture(e.pointerId);
                    } catch(err) {}
                    window.removeEventListener('pointermove', onResizePointerMove);
                    window.removeEventListener('pointerup', onResizePointerUp);
                    window.removeEventListener('pointercancel', onResizePointerUp);
                }
            }
        }

        window.setTestPlayerSize = setTestPlayerSize;
        window.toggleTestPlayerMaximize = toggleTestPlayerMaximize;
        window.resetTestPlayerPosition = resetTestPlayerPosition;
        window.toggleTestPlayerDock = toggleTestPlayerDock;
        window.initTestPlayerDragAndResize = initTestPlayerDragAndResize;

        // Auto initialize drag and resize handlers
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initTestPlayerDragAndResize);
        } else {
            initTestPlayerDragAndResize();
        }

        // ===============================================
        // Embedded Floating Kiosk Player (Movable & Resizable)
        // ===============================================
        let isFloatingKioskMaximized = false;
        let isFloatingKioskDocked = false;
        let isDraggingFloatingKiosk = false;
        let isResizingFloatingKiosk = false;
        let floatingKioskPrevRect = null;

        function openFloatingKioskPlayer() {
            const modal = document.getElementById('floating-kiosk-modal');
            const iframe = document.getElementById('floating-kiosk-iframe');
            const card = document.getElementById('floating-kiosk-card');
            const currentUser = (window.IPTV_CONFIG.currentUser || window.IPTV_CONFIG.adminUser || "admin");
            const kioskUrl = `kiosk?user=${encodeURIComponent(currentUser)}&embedded=1`;

            if (iframe && (!iframe.src || iframe.src === 'about:blank' || iframe.src.indexOf('kiosk') === -1)) {
                iframe.src = kioskUrl;
            }
            if (modal) {
                modal.classList.add('active', 'floating');
            }
            initFloatingKioskDragAndResize();

            if (card && (!card.style.left || !card.style.top || !isFloatingKioskDocked)) {
                const cardW = Math.min(780, Math.floor(window.innerWidth * 0.94));
                const leftPos = Math.max(10, Math.floor((window.innerWidth - cardW) / 2));
                const topPos = Math.max(20, Math.floor((window.innerHeight - 520) / 2));
                card.style.position = 'fixed';
                card.style.left = `${leftPos}px`;
                card.style.top = `${topPos}px`;
                card.style.margin = '0';
                card.style.width = `${cardW}px`;
                const centerBtn = document.getElementById('floating-kiosk-center-btn');
                if (centerBtn) centerBtn.style.display = 'inline-flex';
            }
        }
        window.openFloatingKioskPlayer = openFloatingKioskPlayer;

        function closeFloatingKioskPlayer() {
            const modal = document.getElementById('floating-kiosk-modal');
            const iframe = document.getElementById('floating-kiosk-iframe');
            if (iframe) {
                iframe.src = ''; // Stops audio and stream immediately
            }
            if (modal) {
                modal.classList.remove('active', 'floating');
            }
        }
        window.closeFloatingKioskPlayer = closeFloatingKioskPlayer;

        function openKioskDesktopPopup() {
            const currentUser = (window.IPTV_CONFIG.currentUser || window.IPTV_CONFIG.adminUser || "admin");
            const w = 920;
            const h = 540;
            const left = Math.max(0, Math.round((screen.width - w) / 2));
            const top = Math.max(0, Math.round((screen.height - h) / 2));
            const win = window.open(
                `kiosk?user=${encodeURIComponent(currentUser)}&popup=1`,
                'IPTVKioskDesktopWindow',
                `popup=yes,width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no`
            );
            if (win) {
                win.focus();
            }
        }
        window.openKioskDesktopPopup = openKioskDesktopPopup;

        function setFloatingKioskSize(sizeKey) {
            const card = document.getElementById('floating-kiosk-card');
            const modal = document.getElementById('floating-kiosk-modal');
            if (!card) return;
            if (isFloatingKioskMaximized) toggleFloatingKioskMaximize();
            let targetW = 760;
            if (sizeKey === 'sm') targetW = 480;
            else if (sizeKey === 'md') targetW = 760;
            else if (sizeKey === 'lg') targetW = 1040;

            targetW = Math.min(targetW, Math.floor(window.innerWidth * 0.96));
            card.classList.remove('custom-height');
            card.style.width = `${targetW}px`;
            card.style.maxWidth = `${targetW}px`;
            card.style.height = 'auto';

            if (modal && modal.classList.contains('floating')) {
                const rect = card.getBoundingClientRect();
                if (rect.right > window.innerWidth) {
                    card.style.left = `${Math.max(10, window.innerWidth - targetW - 20)}px`;
                }
                if (rect.bottom > window.innerHeight) {
                    card.style.top = `${Math.max(10, window.innerHeight - card.offsetHeight - 20)}px`;
                }
            }
        }
        window.setFloatingKioskSize = setFloatingKioskSize;

        function toggleFloatingKioskMaximize() {
            const card = document.getElementById('floating-kiosk-card');
            const maxBtn = document.getElementById('floating-kiosk-max-btn');
            if (!card) return;
            isFloatingKioskMaximized = !isFloatingKioskMaximized;
            if (isFloatingKioskMaximized) {
                floatingKioskPrevRect = {
                    width: card.style.width,
                    maxWidth: card.style.maxWidth,
                    height: card.style.height,
                    left: card.style.left,
                    top: card.style.top,
                    right: card.style.right,
                    bottom: card.style.bottom,
                    position: card.style.position
                };
                card.classList.add('is-maximized');
                if (maxBtn) maxBtn.textContent = '🗗 Restore';
            } else {
                card.classList.remove('is-maximized');
                if (floatingKioskPrevRect) {
                    card.style.width = floatingKioskPrevRect.width || '780px';
                    card.style.maxWidth = floatingKioskPrevRect.maxWidth || '94%';
                    card.style.height = floatingKioskPrevRect.height || 'auto';
                    card.style.left = floatingKioskPrevRect.left || '';
                    card.style.top = floatingKioskPrevRect.top || '';
                    card.style.right = floatingKioskPrevRect.right || '';
                    card.style.bottom = floatingKioskPrevRect.bottom || '';
                    card.style.position = floatingKioskPrevRect.position || '';
                }
                if (maxBtn) maxBtn.textContent = '🗖';
            }
        }
        window.toggleFloatingKioskMaximize = toggleFloatingKioskMaximize;

        function resetFloatingKioskPosition() {
            const card = document.getElementById('floating-kiosk-card');
            const modal = document.getElementById('floating-kiosk-modal');
            const centerBtn = document.getElementById('floating-kiosk-center-btn');
            const dockBtn = document.getElementById('floating-kiosk-dock-btn');
            if (!card) return;
            if (isFloatingKioskMaximized) toggleFloatingKioskMaximize();
            isFloatingKioskDocked = false;
            card.classList.remove('custom-height');
            const cardW = Math.min(780, Math.floor(window.innerWidth * 0.94));
            const leftPos = Math.max(10, Math.floor((window.innerWidth - cardW) / 2));
            const topPos = Math.max(20, Math.floor((window.innerHeight - 520) / 2));
            card.style.position = 'fixed';
            card.style.left = `${leftPos}px`;
            card.style.top = `${topPos}px`;
            card.style.right = 'auto';
            card.style.bottom = 'auto';
            card.style.margin = '0';
            card.style.width = `${cardW}px`;
            card.style.maxWidth = '94%';
            card.style.height = 'auto';
            if (modal) {
                modal.classList.add('floating');
                modal.classList.remove('docked');
            }
            if (centerBtn) centerBtn.style.display = 'inline-flex';
            if (dockBtn) {
                dockBtn.textContent = '🗗 Dock';
                dockBtn.title = 'Dock to bottom corner to browse playlist';
            }
        }
        window.resetFloatingKioskPosition = resetFloatingKioskPosition;

        function toggleFloatingKioskDock() {
            const modal = document.getElementById('floating-kiosk-modal');
            const card = document.getElementById('floating-kiosk-card');
            const dockBtn = document.getElementById('floating-kiosk-dock-btn');
            const centerBtn = document.getElementById('floating-kiosk-center-btn');
            if (!modal || !card) return;
            isFloatingKioskDocked = !isFloatingKioskDocked;
            if (isFloatingKioskDocked) {
                if (isFloatingKioskMaximized) toggleFloatingKioskMaximize();
                modal.classList.add('docked');
                modal.classList.remove('floating');
                card.classList.remove('custom-height');
                card.style.position = 'fixed';
                card.style.left = 'auto';
                card.style.top = 'auto';
                card.style.right = '24px';
                card.style.bottom = '24px';
                card.style.width = '520px';
                card.style.maxWidth = '92vw';
                card.style.height = 'auto';
                if (centerBtn) centerBtn.style.display = 'inline-flex';
                if (dockBtn) {
                    dockBtn.textContent = '🗖 Center';
                    dockBtn.title = 'Center kiosk window on screen';
                }
            } else {
                resetFloatingKioskPosition();
            }
        }
        window.toggleFloatingKioskDock = toggleFloatingKioskDock;

        function initFloatingKioskDragAndResize() {
            const card = document.getElementById('floating-kiosk-card');
            const header = document.getElementById('floating-kiosk-header');
            const grip = document.getElementById('floating-kiosk-resize-grip');
            const modal = document.getElementById('floating-kiosk-modal');
            const centerBtn = document.getElementById('floating-kiosk-center-btn');
            if (!card || !header) return;
            if (header.dataset.dragInit === 'true') return;
            header.dataset.dragInit = 'true';

            let dragStartX = 0, dragStartY = 0, initialLeft = 0, initialTop = 0;
            let resizeStartX = 0, resizeStartY = 0, initialW = 0, initialH = 0;

            // Double-click header to maximize/restore
            header.addEventListener('dblclick', (e) => {
                if (e.target.closest('button, a, input, select, textarea')) return;
                toggleFloatingKioskMaximize();
            });

            header.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button, a, input, select, textarea')) return;
                if (isFloatingKioskMaximized) return;
                e.preventDefault();

                try {
                    header.setPointerCapture(e.pointerId);
                } catch(err) {}

                isDraggingFloatingKiosk = true;
                document.body.classList.add('kiosk-float-drag-active');

                const rect = card.getBoundingClientRect();
                card.style.position = 'fixed';
                card.style.left = `${rect.left}px`;
                card.style.top = `${rect.top}px`;
                card.style.right = 'auto';
                card.style.bottom = 'auto';
                card.style.margin = '0';
                if (modal) {
                    modal.classList.add('floating');
                    modal.classList.remove('docked');
                }
                isFloatingKioskDocked = false;
                if (centerBtn) centerBtn.style.display = 'inline-flex';

                dragStartX = e.clientX;
                dragStartY = e.clientY;
                initialLeft = rect.left;
                initialTop = rect.top;

                function onMove(me) {
                    if (!isDraggingFloatingKiosk) return;
                    const dx = me.clientX - dragStartX;
                    const dy = me.clientY - dragStartY;
                    let newLeft = initialLeft + dx;
                    let newTop = initialTop + dy;
                    const cardW = card.offsetWidth;
                    const cardH = card.offsetHeight;
                    newLeft = Math.max(0, Math.min(window.innerWidth - cardW, newLeft));
                    newTop = Math.max(0, Math.min(window.innerHeight - cardH, newTop));
                    card.style.left = `${newLeft}px`;
                    card.style.top = `${newTop}px`;
                }

                function onUp(ue) {
                    if (!isDraggingFloatingKiosk) return;
                    isDraggingFloatingKiosk = false;
                    document.body.classList.remove('kiosk-float-drag-active');
                    try {
                        header.releasePointerCapture(ue.pointerId);
                    } catch(err) {}
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    window.removeEventListener('pointercancel', onUp);
                }

                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
                window.addEventListener('pointercancel', onUp);
            });

            if (grip) {
                grip.addEventListener('pointerdown', (e) => {
                    if (isFloatingKioskMaximized) return;
                    e.preventDefault();
                    e.stopPropagation();

                    try {
                        grip.setPointerCapture(e.pointerId);
                    } catch(err) {}

                    isResizingFloatingKiosk = true;
                    document.body.classList.add('kiosk-float-resize-active');

                    const rect = card.getBoundingClientRect();
                    resizeStartX = e.clientX;
                    resizeStartY = e.clientY;
                    initialW = rect.width;
                    initialH = rect.height;

                    function onMove(me) {
                        if (!isResizingFloatingKiosk) return;
                        const dx = me.clientX - resizeStartX;
                        const dy = me.clientY - resizeStartY;
                        let newW = Math.max(360, Math.min(window.innerWidth - rect.left - 10, initialW + dx));
                        let newH = Math.max(240, Math.min(window.innerHeight - rect.top - 10, initialH + dy));
                        card.classList.add('custom-height');
                        card.style.width = `${newW}px`;
                        card.style.maxWidth = `${newW}px`;
                        card.style.height = `${newH}px`;
                    }

                    function onUp(ue) {
                        if (!isResizingFloatingKiosk) return;
                        isResizingFloatingKiosk = false;
                        document.body.classList.remove('kiosk-float-resize-active');
                        try {
                            grip.releasePointerCapture(ue.pointerId);
                        } catch(err) {}
                        window.removeEventListener('pointermove', onMove);
                        window.removeEventListener('pointerup', onUp);
                        window.removeEventListener('pointercancel', onUp);
                    }

                    window.addEventListener('pointermove', onMove);
                    window.addEventListener('pointerup', onUp);
                    window.addEventListener('pointercancel', onUp);
                });
            }
        }
        window.initFloatingKioskDragAndResize = initFloatingKioskDragAndResize;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initFloatingKioskDragAndResize);
        } else {
            initFloatingKioskDragAndResize();
        }

        function testCardStream(rawUrl, channelName = '') {
            if (!rawUrl) return;
            try {
                if (channelName && typeof channelName === 'string' && channelName.includes('%')) {
                    channelName = decodeURIComponent(channelName);
                }
            } catch(e) {}
            openTestPlayer(rawUrl, channelName);
        }

        function testCardStreamByIndex(index) {
            const streams = playlistData.streams || [];
            const s = streams[index];
            if (s && s.url) {
                openTestPlayer(s.url, s.name || `Channel ${index + 1}`);
            }
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.getElementById('test-player-modal');
                if (modal && modal.classList.contains('active')) {
                    closeTestPlayer();
                }
            }
        });

        function deleteCardStream(index) {
            if (confirm("Are you sure you want to remove this stream from the playlist?")) {
                playlistData.streams.splice(index, 1);
                isFormModified = true;
                renderCategorizedGrid();
            }
        }

        function toggleChannelScheduleFields() {
            const isTemp = document.querySelector('input[name="edit-stream-schedule-type"]:checked')?.value === 'temporary';
            const box = document.getElementById('channel-schedule-restriction-box');
            if (box) box.style.display = isTemp ? 'block' : 'none';
        }

        function openEditModal(index) {
            const modal = document.getElementById('channel-modal');
            const title = document.getElementById('modal-title-text');
            const nameInput = document.getElementById('edit-stream-name');
            const categoryInput = document.getElementById('edit-stream-category');
            const urlInput = document.getElementById('edit-stream-url');
            const durationMinInput = document.getElementById('edit-stream-duration-minutes');
            const durationSecInput = document.getElementById('edit-stream-duration-seconds');
            const durationInput = document.getElementById('edit-stream-duration');
            const typeInput = document.getElementById('edit-stream-type');
            const indexInput = document.getElementById('edit-stream-index');
            const startDateInput = document.getElementById('edit-stream-start-date');
            const endDateInput = document.getElementById('edit-stream-end-date');
            const startTimeInput = document.getElementById('edit-stream-start-time');
            const endTimeInput = document.getElementById('edit-stream-end-time');
            
            indexInput.value = index;
            
            if (index >= 0) {
                title.textContent = "✏️ Edit Channel";
                const s = playlistData.streams[index];
                nameInput.value = s.name || '';
                categoryInput.value = s.category || '';
                urlInput.value = s.url || '';
                typeInput.value = s.type || 'youtube_embed';
                
                const schedType = s.schedule_type || 'permanent';
                const radio = document.querySelector(`input[name="edit-stream-schedule-type"][value="${schedType}"]`);
                if (radio) radio.checked = true;
                if (startDateInput) startDateInput.value = s.start_date || '';
                if (endDateInput) endDateInput.value = s.end_date || '';
                if (startTimeInput) startTimeInput.value = s.start_time || '';
                if (endTimeInput) endTimeInput.value = s.end_time || '';
                const winSelect = document.getElementById('edit-stream-schedule-window');
                if (winSelect) {
                    winSelect.value = String(s.schedule_window || (s.start_time && document.getElementById('temp-schedule-2-start')?.value && s.start_time === document.getElementById('temp-schedule-2-start').value ? 2 : 1));
                }
                toggleChannelScheduleFields();

                if (s.duration_seconds !== undefined && s.duration_seconds !== null && s.duration_seconds !== '') {
                    const totalSec = parseInt(s.duration_seconds);
                    if (!isNaN(totalSec) && totalSec > 0) {
                        const m = Math.floor(totalSec / 60);
                        const sec = totalSec % 60;
                        durationMinInput.value = m > 0 ? m : '';
                        durationSecInput.value = sec > 0 ? sec : (m > 0 ? 0 : '');
                        if (durationInput) durationInput.value = totalSec;
                    } else {
                        durationMinInput.value = '';
                        durationSecInput.value = '';
                        if (durationInput) durationInput.value = '';
                    }
                } else {
                    durationMinInput.value = '';
                    durationSecInput.value = '';
                    if (durationInput) durationInput.value = '';
                }
            } else {
                title.textContent = "➕ Add Channel";
                nameInput.value = '';
                categoryInput.value = '';
                urlInput.value = '';
                durationMinInput.value = '';
                durationSecInput.value = '';
                if (durationInput) durationInput.value = '';
                typeInput.value = 'youtube_embed';

                const radio = document.querySelector('input[name="edit-stream-schedule-type"][value="permanent"]');
                if (radio) radio.checked = true;
                if (startDateInput) startDateInput.value = '';
                if (endDateInput) endDateInput.value = '';
                if (startTimeInput) startTimeInput.value = '';
                if (endTimeInput) endTimeInput.value = '';
                const winSelect = document.getElementById('edit-stream-schedule-window');
                if (winSelect) winSelect.value = '1';
                toggleChannelScheduleFields();
            }
            
            modal.classList.add('active');
        }

        function closeEditModal() {
            document.getElementById('channel-modal').classList.remove('active');
        }

        function saveChannelFromModal() {
            const index = parseInt(document.getElementById('edit-stream-index').value);
            const name = document.getElementById('edit-stream-name').value.trim();
            const category = document.getElementById('edit-stream-category').value.trim();
            const url = document.getElementById('edit-stream-url').value.trim();
            const minVal = document.getElementById('edit-stream-duration-minutes').value.trim();
            const secVal = document.getElementById('edit-stream-duration-seconds').value.trim();
            const type = document.getElementById('edit-stream-type').value;
            const schedType = document.querySelector('input[name="edit-stream-schedule-type"]:checked')?.value || 'permanent';
            const schedWindow = parseInt(document.getElementById('edit-stream-schedule-window')?.value || '1');
            const startDate = document.getElementById('edit-stream-start-date')?.value?.trim() || '';
            const endDate = document.getElementById('edit-stream-end-date')?.value?.trim() || '';
            const startTime = document.getElementById('edit-stream-start-time')?.value?.trim() || '';
            const endTime = document.getElementById('edit-stream-end-time')?.value?.trim() || '';
            
            if (!url) {
                alert("Stream URL is required!");
                return;
            }
            if (!isValidUrl(url)) {
                alert("Invalid URL format! Must start with http:// or https://");
                return;
            }
            
            const newStream = (index >= 0 && playlistData.streams[index]) 
                ? { ...playlistData.streams[index], url, type } 
                : { url, type };
            if (name) newStream.name = name; else delete newStream.name;
            if (category) newStream.category = category; else delete newStream.category;
            
            newStream.schedule_type = schedType;
            if (schedType === 'temporary') {
                newStream.schedule_window = schedWindow;
                if (startDate) newStream.start_date = startDate; else delete newStream.start_date;
                if (endDate) newStream.end_date = endDate; else delete newStream.end_date;
                if (startTime) newStream.start_time = startTime; else delete newStream.start_time;
                if (endTime) newStream.end_time = endTime; else delete newStream.end_time;
            } else {
                delete newStream.schedule_window;
                delete newStream.start_date;
                delete newStream.end_date;
                delete newStream.start_time;
                delete newStream.end_time;
            }

            if (minVal !== '' || secVal !== '') {
                const mins = parseInt(minVal) || 0;
                const secs = parseInt(secVal) || 0;
                const totalSeconds = (mins * 60) + secs;
                if (totalSeconds > 0) {
                    newStream.duration_seconds = totalSeconds;
                } else {
                    delete newStream.duration_seconds;
                }
            } else {
                delete newStream.duration_seconds;
            }
            
            if (index >= 0) {
                playlistData.streams[index] = newStream;
            } else {
                playlistData.streams.push(newStream);
            }
            
            isFormModified = true;
            closeEditModal();
            renderCategorizedGrid();
        }

        function updateQuietHoursBadge() {
            const badge = document.getElementById('quiet-hours-status-badge');
            const enabledEl = document.getElementById('quiet-hours-enabled');
            const startEl = document.getElementById('quiet-hours-start');
            const endEl = document.getElementById('quiet-hours-end');
            if (!badge) return;

            const enabled = enabledEl ? enabledEl.checked : false;
            const start = (startEl && startEl.value) ? startEl.value : '22:00';
            const end = (endEl && endEl.value) ? endEl.value : '07:00';

            if (!enabled) {
                badge.style.background = 'rgba(148, 163, 184, 0.15)';
                badge.style.color = '#94a3b8';
                badge.style.border = '1px solid rgba(148, 163, 184, 0.3)';
                badge.textContent = 'Disabled';
                return;
            }

            const now = new Date();
            const currentMins = now.getHours() * 60 + now.getMinutes();
            const [sH, sM] = start.split(':').map(Number);
            const [eH, eM] = end.split(':').map(Number);
            const startMins = (sH || 0) * 60 + (sM || 0);
            const endMins = (eH || 0) * 60 + (eM || 0);

            let isActive = false;
            if (startMins <= endMins) {
                isActive = currentMins >= startMins && currentMins < endMins;
            } else {
                isActive = currentMins >= startMins || currentMins < endMins;
            }

            if (isActive) {
                badge.style.background = 'rgba(239, 68, 68, 0.2)';
                badge.style.color = '#f87171';
                badge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
                badge.textContent = `🌙 Active Now (${start} - ${end})`;
            } else {
                badge.style.background = 'rgba(59, 130, 246, 0.15)';
                badge.style.color = 'var(--accent-color)';
                badge.style.border = '1px solid rgba(59, 130, 246, 0.3)';
                badge.textContent = `Scheduled (${start} - ${end})`;
            }
        }

        function evaluateWindowActive(enabled, start, end, sDate, eDate) {
            if (!enabled) return { enabled: false, active: false, statusText: 'Disabled', badgeClass: 'disabled' };
            const now = new Date();
            if (sDate) {
                const startD = new Date(sDate + "T00:00:00");
                if (now < startD) {
                    return { enabled: true, active: false, statusText: `Starts on ${sDate} (${start}-${end})`, badgeClass: 'scheduled' };
                }
            }
            if (eDate) {
                const endD = new Date(eDate + "T23:59:59");
                if (now > endD) {
                    return { enabled: true, active: false, statusText: `Expired on ${eDate}`, badgeClass: 'expired' };
                }
            }
            const currentMins = now.getHours() * 60 + now.getMinutes();
            const [sH, sM] = start.split(':').map(Number);
            const [eH, eM] = end.split(':').map(Number);
            const startMins = (sH || 0) * 60 + (sM || 0);
            const endMins = (eH || 0) * 60 + (eM || 0);

            let isActive = false;
            if (startMins <= endMins) {
                isActive = currentMins >= startMins && currentMins < endMins;
            } else {
                isActive = currentMins >= startMins || currentMins < endMins;
            }

            if (isActive) {
                return { enabled: true, active: true, statusText: `Active (${start} - ${end})`, badgeClass: 'active' };
            }
            return { enabled: true, active: false, statusText: `Scheduled (${start} - ${end})`, badgeClass: 'scheduled' };
        }

        function setWindowBadgeStyle(badgeEl, info) {
            if (!badgeEl) return;
            if (!info.enabled) {
                badgeEl.style.background = '#f1f5f9';
                badgeEl.style.color = '#475569';
                badgeEl.style.border = '1px solid #cbd5e1';
                badgeEl.textContent = 'Disabled';
            } else if (info.active) {
                badgeEl.style.background = 'rgba(245, 158, 11, 0.2)';
                badgeEl.style.color = '#b45309';
                badgeEl.style.border = '1px solid rgba(245, 158, 11, 0.5)';
                badgeEl.textContent = `🕒 ${info.statusText}`;
            } else if (info.badgeClass === 'expired') {
                badgeEl.style.background = '#f1f5f9';
                badgeEl.style.color = '#94a3b8';
                badgeEl.style.border = '1px solid #cbd5e1';
                badgeEl.textContent = info.statusText;
            } else {
                badgeEl.style.background = 'rgba(59, 130, 246, 0.15)';
                badgeEl.style.color = 'var(--accent-color)';
                badgeEl.style.border = '1px solid rgba(59, 130, 246, 0.3)';
                badgeEl.textContent = info.statusText;
            }
        }

        function updateTemporaryScheduleBadge() {
            const overallBadge = document.getElementById('temp-schedule-status-badge');
            const win1Badge = document.getElementById('temp-win1-status-badge');
            const win2Badge = document.getElementById('temp-win2-status-badge');
            const headerBadge = document.getElementById('temporary-mode-header-badge');
            const headerText = document.getElementById('temporary-mode-header-text');

            // Window 1 inputs
            const enabled1 = document.getElementById('temp-schedule-enabled')?.checked || false;
            const start1 = document.getElementById('temp-schedule-start')?.value || '06:00';
            const end1 = document.getElementById('temp-schedule-end')?.value || '12:00';
            const sDate1 = document.getElementById('temp-schedule-start-date')?.value || '';
            const eDate1 = document.getElementById('temp-schedule-end-date')?.value || '';

            // Window 2 inputs
            const enabled2 = document.getElementById('temp-schedule-2-enabled')?.checked || false;
            const start2 = document.getElementById('temp-schedule-2-start')?.value || '18:00';
            const end2 = document.getElementById('temp-schedule-2-end')?.value || '22:00';
            const sDate2 = document.getElementById('temp-schedule-2-start-date')?.value || '';
            const eDate2 = document.getElementById('temp-schedule-2-end-date')?.value || '';

            const info1 = evaluateWindowActive(enabled1, start1, end1, sDate1, eDate1);
            const info2 = evaluateWindowActive(enabled2, start2, end2, sDate2, eDate2);

            setWindowBadgeStyle(win1Badge, info1);
            setWindowBadgeStyle(win2Badge, info2);

            const isAnyActive = info1.active || info2.active;
            const isAnyEnabled = info1.enabled || info2.enabled;

            if (isAnyActive) {
                const activeWinLabels = [];
                if (info1.active) activeWinLabels.push(`Win 1 (${start1}-${end1})`);
                if (info2.active) activeWinLabels.push(`Win 2 (${start2}-${end2})`);
                const winDesc = activeWinLabels.join(' & ');

                if (overallBadge) {
                    overallBadge.style.background = 'rgba(245, 158, 11, 0.2)';
                    overallBadge.style.color = '#b45309';
                    overallBadge.style.border = '1px solid rgba(245, 158, 11, 0.5)';
                    overallBadge.textContent = `🕒 Active Now (${winDesc})`;
                }
                if (headerBadge) {
                    headerBadge.style.display = 'inline-flex';
                    if (headerText) headerText.textContent = `Temp Window Active (${winDesc})`;
                }
            } else if (isAnyEnabled) {
                const schedLabels = [];
                if (info1.enabled) schedLabels.push(`W1: ${start1}-${end1}`);
                if (info2.enabled) schedLabels.push(`W2: ${start2}-${end2}`);
                const schedDesc = schedLabels.join(', ');

                if (overallBadge) {
                    overallBadge.style.background = 'rgba(59, 130, 246, 0.15)';
                    overallBadge.style.color = 'var(--accent-color)';
                    overallBadge.style.border = '1px solid rgba(59, 130, 246, 0.3)';
                    overallBadge.textContent = `Scheduled (${schedDesc})`;
                }
                if (headerBadge) headerBadge.style.display = 'none';
            } else {
                if (overallBadge) {
                    overallBadge.style.background = '#f1f5f9';
                    overallBadge.style.color = '#475569';
                    overallBadge.style.border = '1px solid #cbd5e1';
                    overallBadge.textContent = 'All Disabled';
                }
                if (headerBadge) headerBadge.style.display = 'none';
            }

            renderTemporaryChannelsList();
        }

        function isStreamForTempWindow(s, winNum) {
            if (!s || typeof s !== 'object') return false;
            if (s.schedule_window !== undefined && s.schedule_window !== null) {
                return parseInt(s.schedule_window) === winNum;
            }
            const prefix = winNum === 2 ? 'temp-schedule-2-' : 'temp-schedule-';
            const wStart = document.getElementById(prefix + 'start')?.value;
            const wEnd = document.getElementById(prefix + 'end')?.value;
            if (wStart && s.start_time && wStart === s.start_time) return true;
            if (wEnd && s.end_time && wEnd === s.end_time) return true;
            return winNum === 1; // Default unassigned to Window 1
        }

        function renderTemporaryChannelsList() {
            const countEl = document.getElementById('temp-channels-summary-count');
            const win1ListEl = document.getElementById('temp-win1-chips-list');
            const win2ListEl = document.getElementById('temp-win2-chips-list');
            const win1CountEl = document.getElementById('temp-win1-count');
            const win2CountEl = document.getElementById('temp-win2-count');
            const legacyListEl = document.getElementById('temp-channels-chips-list');

            const streams = (typeof playlistData !== 'undefined' && playlistData && Array.isArray(playlistData.streams)) ? playlistData.streams : [];
            const tempStreamsWin1 = [];
            const tempStreamsWin2 = [];

            streams.forEach((s, idx) => {
                if (isStreamTemporary(s)) {
                    if (isStreamForTempWindow(s, 2)) {
                        tempStreamsWin2.push({ stream: s, index: idx });
                    } else {
                        tempStreamsWin1.push({ stream: s, index: idx });
                    }
                }
            });

            const totalCount = tempStreamsWin1.length + tempStreamsWin2.length;
            if (countEl) {
                countEl.textContent = `${totalCount} Temporary Channel${totalCount === 1 ? '' : 's'}`;
            }
            if (win1CountEl) win1CountEl.textContent = String(tempStreamsWin1.length);
            if (win2CountEl) win2CountEl.textContent = String(tempStreamsWin2.length);

            // Provider badge per channel (same canonical names as the proxy's connection limits)
            const providerStyles = {
                'Primary Provider': ['⚡', '#ede9fe', '#5b21b6', '#ddd6fe'],
                'Tubi TV': ['🍿', '#ffedd5', '#9a3412', '#fed7aa'],
                'Pluto TV': ['🪐', '#e0f2fe', '#075985', '#bae6fd'],
                'YouTube': ['📺', '#fee2e2', '#991b1b', '#fecaca'],
            };
            const providerBadge = (name) => {
                const [icon, bg, fg, border] = providerStyles[name] || ['🌐', '#f1f5f9', '#334155', '#e2e8f0'];
                return `<span style="font-size: 10px; padding: 1px 6px; border-radius: 10px; background: ${bg}; color: ${fg}; border: 1px solid ${border}; font-weight: 600; white-space: nowrap;" title="Provider">${icon} ${escapeHtml(name)}</span>`;
            };

            const renderChips = (list, targetEl, emptyMsg) => {
                if (!targetEl) return;
                if (list.length === 0) {
                    targetEl.innerHTML = `<span style="font-size: 11px; color: var(--muted); font-style: italic; padding: 6px 0;">${emptyMsg}</span>`;
                    return;
                }
                // Per-provider totals, so a window that leans on a capped provider stands out
                const counts = {};
                list.forEach(({ stream }) => {
                    const prov = getStreamSubscriptionKey(stream);
                    counts[prov] = (counts[prov] || 0) + 1;
                });
                let html = `<div style="flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 2px;">${
                    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([prov, n]) => `${providerBadge(prov)}<span style="font-size: 10px; color: var(--muted); margin-right: 4px;">×${n}</span>`).join('')
                }</div>`;
                list.forEach(({ stream, index }) => {
                    const name = stream.name || `Channel ${index + 1}`;
                    const isActive = isStreamActiveNow(stream);
                    const statusDot = isActive ? '🟢' : '⏳';
                    const timeStr = (stream.start_time || stream.end_time) ? ` (${stream.start_time || '00:00'}-${stream.end_time || '23:59'})` : '';
                    html += `
                        <div style="display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; background: #ffffff; border: 1px solid var(--line); border-radius: 6px; font-size: 11px; color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                            <span>${statusDot}</span>
                            <strong style="max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
                            ${providerBadge(getStreamSubscriptionKey(stream))}
                            <span style="font-size: 10px; color: var(--muted);">${timeStr}</span>
                            <button type="button" onclick="testCardStreamByIndex(${index})" style="background: none; border: none; cursor: pointer; padding: 0 2px; font-size: 11px;" title="Test / Preview Channel">🔗</button>
                            <button type="button" onclick="openEditModal(${index})" style="background: none; border: none; cursor: pointer; padding: 0 2px; font-size: 11px;" title="Edit Channel">✏️</button>
                            <button type="button" onclick="deleteTemporaryChannel(${index}, event)" style="background: none; border: none; cursor: pointer; padding: 0 2px; font-size: 11px; color: #dc2626;" title="Delete Channel from this window">❌</button>
                        </div>
                    `;
                });
                targetEl.innerHTML = html;
            };

            renderChips(tempStreamsWin1, win1ListEl, 'No channels in Window 1. Click 🔍 Search or + Add to Win 1.');
            renderChips(tempStreamsWin2, win2ListEl, 'No channels in Window 2. Click 🔍 Search or + Add to Win 2.');

            if (legacyListEl) {
                renderChips([...tempStreamsWin1, ...tempStreamsWin2], legacyListEl, 'No temporary channels added yet.');
            }
        }

        function deleteTemporaryChannel(index, evt) {
            if (evt) evt.stopPropagation();
            if (index < 0 || !playlistData || !Array.isArray(playlistData.streams) || index >= playlistData.streams.length) return;
            const targetChannel = playlistData.streams[index];
            const chName = targetChannel.name || `Channel ${index + 1}`;
            if (confirm(`Are you sure you want to delete "${chName}" from this temporary window?`)) {
                playlistData.streams.splice(index, 1);
                isFormModified = true;
                renderCategorizedGrid();
                renderTemporaryChannelsList();
            }
        }

        function clearAllTempWindowChannels(windowNumber) {
            if (!playlistData || !Array.isArray(playlistData.streams)) return;
            const streams = playlistData.streams;
            const matchingCount = streams.filter(s => isStreamTemporary(s) && isStreamForTempWindow(s, windowNumber)).length;
            if (matchingCount === 0) {
                alert(`Window ${windowNumber} has no channels to delete.`);
                return;
            }
            if (confirm(`Are you sure you want to delete all ${matchingCount} channels from Temporary Window ${windowNumber}?`)) {
                playlistData.streams = streams.filter(s => !(isStreamTemporary(s) && isStreamForTempWindow(s, windowNumber)));
                isFormModified = true;
                renderCategorizedGrid();
                renderTemporaryChannelsList();
            }
        }

        function toggleTempChannelsListModal() {
            const container = document.getElementById('temp-channels-list-container');
            if (container) {
                container.style.display = container.style.display === 'none' ? 'block' : 'none';
            }
        }

        function openAddTemporaryChannelModal(windowNumber) {
            openEditModal(-1);
            const radio = document.querySelector('input[name="edit-stream-schedule-type"][value="temporary"]');
            if (radio) radio.checked = true;
            toggleChannelScheduleFields();

            const title = document.getElementById('modal-title-text');
            if (title) title.textContent = `➕ Add Channel (Temporary Window ${windowNumber})`;

            // Pre-fill time range from the requested window
            const prefix = windowNumber === 2 ? 'temp-schedule-2-' : 'temp-schedule-';
            const sTime = document.getElementById(prefix + 'start')?.value || '';
            const eTime = document.getElementById(prefix + 'end')?.value || '';
            const sDate = document.getElementById(prefix + 'start-date')?.value || '';
            const eDate = document.getElementById(prefix + 'end-date')?.value || '';

            const sTimeInput = document.getElementById('edit-stream-start-time');
            const eTimeInput = document.getElementById('edit-stream-end-time');
            const sDateInput = document.getElementById('edit-stream-start-date');
            const eDateInput = document.getElementById('edit-stream-end-date');

            if (sTimeInput && sTime) sTimeInput.value = sTime;
            if (eTimeInput && eTime) eTimeInput.value = eTime;
            if (sDateInput && sDate) sDateInput.value = sDate;
            if (eDateInput && eDate) eDateInput.value = eDate;
            const winSelect = document.getElementById('edit-stream-schedule-window');
            if (winSelect) winSelect.value = String(windowNumber === 2 ? 2 : 1);
        }

        let currentTempSearchWindow = 1;
        let currentTempSearchSource = 'db'; // 'db' or 'youtube'
        let tempWindowSearchTimeout = null;

        function setTempSearchSource(source) {
            currentTempSearchSource = source === 'youtube' ? 'youtube' : 'db';
            const dbBtn = document.getElementById('temp-search-source-db');
            const ytBtn = document.getElementById('temp-search-source-yt');
            const inp = document.getElementById('temp-search-modal-input');

            if (dbBtn) {
                dbBtn.style.background = currentTempSearchSource === 'db' ? '#2563eb' : '#ffffff';
                dbBtn.style.color = currentTempSearchSource === 'db' ? '#ffffff' : 'var(--ink)';
                dbBtn.style.borderColor = currentTempSearchSource === 'db' ? '#2563eb' : 'var(--line)';
            }
            if (ytBtn) {
                ytBtn.style.background = currentTempSearchSource === 'youtube' ? '#dc2626' : '#ffffff';
                ytBtn.style.color = currentTempSearchSource === 'youtube' ? '#ffffff' : 'var(--ink)';
                ytBtn.style.borderColor = currentTempSearchSource === 'youtube' ? '#dc2626' : 'var(--line)';
            }
            if (inp) {
                inp.placeholder = currentTempSearchSource === 'youtube'
                    ? '▶️ Search YouTube Live streams & videos... (e.g. NBC News live, lofi, relaxing nature)'
                    : '🔍 Type channel name to search across all providers... (e.g. ESPN, HBO, NBC)';
            }
            // Trigger search with current input
            if (inp && inp.value.trim().length >= 2) {
                onTempWindowSearchInput(inp.value);
            }
        }

        function updateTempSearchModalInfo() {
            const prefix = currentTempSearchWindow === 2 ? 'temp-schedule-2-' : 'temp-schedule-';
            const sTime = document.getElementById(prefix + 'start')?.value || '00:00';
            const eTime = document.getElementById(prefix + 'end')?.value || '23:59';
            const sDate = document.getElementById(prefix + 'start-date')?.value || '';
            const eDate = document.getElementById(prefix + 'end-date')?.value || '';

            const titleEl = document.getElementById('temp-search-modal-title');
            const badgeEl = document.getElementById('temp-search-modal-target-badge');
            const hoursEl = document.getElementById('temp-search-modal-window-hours');
            const selEl = document.getElementById('temp-search-modal-window-select');
            const labelEl = document.getElementById('temp-search-modal-window-label');

            if (titleEl) titleEl.textContent = `🔍 Search Channels (Window ${currentTempSearchWindow})`;
            if (badgeEl) badgeEl.textContent = `Target: Window ${currentTempSearchWindow}`;
            if (labelEl) labelEl.textContent = `Window ${currentTempSearchWindow}`;
            if (selEl) selEl.value = String(currentTempSearchWindow);
            if (hoursEl) {
                let range = `Hours: ${sTime} - ${eTime}`;
                if (sDate || eDate) range += ` | Dates: ${sDate || 'Any'} to ${eDate || 'Any'}`;
                hoursEl.textContent = range;
            }
        }

        function switchTempSearchModalWindow(winNum) {
            currentTempSearchWindow = winNum === 2 ? 2 : 1;
            updateTempSearchModalInfo();
            // Re-render current results to update button labels and targets
            if (window.currentTempSearchResults && window.currentTempSearchResults.length > 0) {
                if (currentTempSearchSource === 'youtube') {
                    renderTempYouTubeResults(window.currentTempSearchResults);
                } else {
                    renderTempSearchResults(window.currentTempSearchResults);
                }
            }
        }

        function openTempWindowSearchModal(windowNumber) {
            currentTempSearchWindow = windowNumber === 2 ? 2 : 1;
            updateTempSearchModalInfo();
            const modal = document.getElementById('temp-window-search-modal');
            if (modal) {
                modal.classList.add('active');
                modal.style.display = 'flex';
                setTimeout(() => {
                    const inp = document.getElementById('temp-search-modal-input');
                    if (inp) inp.focus();
                }, 100);
            }
        }

        function closeTempWindowSearchModal() {
            const modal = document.getElementById('temp-window-search-modal');
            if (modal) {
                modal.classList.remove('active');
                modal.style.display = 'none';
            }
        }

        function onTempWindowSearchInput(val) {
            if (tempWindowSearchTimeout) clearTimeout(tempWindowSearchTimeout);
            const query = (val || '').trim();
            const resultsContainer = document.getElementById('temp-search-modal-results');
            if (!resultsContainer) return;

            if (query.length < 2) {
                const hint = currentTempSearchSource === 'youtube'
                    ? 'Type at least 2 characters above to search YouTube Live streams.'
                    : 'Type at least 2 characters above to search 1.8M channels across all providers.';
                resultsContainer.innerHTML = `<div style="color: var(--muted); padding: 25px; text-align: center; font-size: 13px;">${hint}</div>`;
                window.currentTempSearchResults = [];
                return;
            }

            if (currentTempSearchSource === 'youtube') {
                resultsContainer.innerHTML = `<div style="color: var(--muted); padding: 25px; text-align: center; font-size: 13px;">▶️ Searching YouTube Live for "${escapeHtml(query)}"...</div>`;
                tempWindowSearchTimeout = setTimeout(async () => {
                    try {
                        const res = await fetch(getApiUrl(`api/youtube/search?q=${encodeURIComponent(query)}`));
                        const data = await safeParseJson(res);
                        if (!Array.isArray(data)) {
                            resultsContainer.innerHTML = `<div style="color: var(--danger-color); padding: 15px; text-align: center; font-size: 13px;">YouTube search failed: ${escapeHtml(data?.error || 'Unknown error')}</div>`;
                            window.currentTempSearchResults = [];
                            return;
                        }
                        if (data.length === 0) {
                            resultsContainer.innerHTML = `<div style="color: var(--muted); padding: 25px; text-align: center; font-size: 13px;">No YouTube videos or streams found for "${escapeHtml(query)}".</div>`;
                            window.currentTempSearchResults = [];
                            return;
                        }
                        window.currentTempSearchResults = data;
                        renderTempYouTubeResults(data);
                    } catch (err) {
                        resultsContainer.innerHTML = `<div style="color: var(--danger-color); padding: 15px; text-align: center; font-size: 13px;">YouTube request error: ${escapeHtml(err.message)}</div>`;
                    }
                }, 350);
            } else {
                resultsContainer.innerHTML = '<div style="color: var(--muted); padding: 25px; text-align: center; font-size: 13px;">🔍 Searching all providers database for "' + escapeHtml(query) + '"...</div>';
                tempWindowSearchTimeout = setTimeout(async () => {
                    try {
                        const res = await fetch(getApiUrl(`api/channels/search?q=${encodeURIComponent(query)}`));
                        const data = await safeParseJson(res);

                        if (!Array.isArray(data)) {
                            resultsContainer.innerHTML = `<div style="color: var(--danger-color); padding: 15px; text-align: center; font-size: 13px;">Error: ${escapeHtml(data.error || 'Failed to query channels')}</div>`;
                            window.currentTempSearchResults = [];
                            return;
                        }

                        if (data.length === 0) {
                            resultsContainer.innerHTML = `<div style="color: var(--muted); padding: 25px; text-align: center; font-size: 13px;">No channels found for "${escapeHtml(query)}" across any provider.</div>`;
                            window.currentTempSearchResults = [];
                            return;
                        }

                        window.currentTempSearchResults = data;
                        renderTempSearchResults(data);
                    } catch (err) {
                        console.error("Temp search error:", err);
                        resultsContainer.innerHTML = `<div style="color: var(--danger-color); padding: 15px; text-align: center; font-size: 13px;">Search request failed: ${escapeHtml(err.message)}</div>`;
                    }
                }, 300);
            }
        }

        function renderTempSearchResults(data) {
            const resultsContainer = document.getElementById('temp-search-modal-results');
            if (!resultsContainer) return;
            resultsContainer.innerHTML = '';

            const fragment = document.createDocumentFragment();
            const displayData = data.slice(0, 100);

            displayData.forEach(ch => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.justifyContent = 'space-between';
                item.style.alignItems = 'center';
                item.style.padding = '10px 14px';
                item.style.background = '#ffffff';
                item.style.border = '1px solid var(--line)';
                item.style.borderRadius = '10px';
                item.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                item.style.fontSize = '13px';
                item.style.color = 'var(--ink)';

                const label = document.createElement('div');
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.gap = '8px';
                label.style.flexWrap = 'wrap';
                label.style.fontWeight = '600';
                label.style.flex = '1';
                label.style.minWidth = '220px';

                let labelText = escapeHtml(ch.name || 'Unnamed Channel');
                if (ch.provider) {
                    labelText += ` <span style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">🏷️ ${escapeHtml(ch.provider)}</span>`;
                }
                if (ch.live_title) {
                    labelText += ` <span style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">🔴 Live: ${escapeHtml(ch.live_title)}</span>`;
                }
                if (ch.category) {
                    labelText += ` <span style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold;">${escapeHtml(ch.category)}</span>`;
                }

                const textSpan = document.createElement('span');
                textSpan.innerHTML = labelText;
                label.appendChild(textSpan);

                const statusBadge = document.createElement('span');
                if (ch.id) statusBadge.id = `temp-search-status-${ch.id}`;
                statusBadge.style.display = 'inline-flex';
                statusBadge.style.alignItems = 'center';
                statusBadge.innerHTML = renderChannelStatusBadge(ch);
                label.appendChild(statusBadge);

                const btnContainer = document.createElement('div');
                btnContainer.style.display = 'flex';
                btnContainer.style.gap = '6px';
                btnContainer.style.alignItems = 'center';
                btnContainer.style.flexShrink = '0';

                // ⚡ Verify Channel Button
                const verifyBtn = document.createElement('button');
                verifyBtn.type = 'button';
                verifyBtn.className = 'btn btn-secondary';
                verifyBtn.style.padding = '6px 9px';
                verifyBtn.style.fontSize = '11px';
                verifyBtn.style.background = '#fef3c7';
                verifyBtn.style.color = '#92400e';
                verifyBtn.style.borderColor = '#fde68a';
                verifyBtn.textContent = '⚡ Verify';
                verifyBtn.title = 'Test stream reachability & latency';
                verifyBtn.onclick = (e) => {
                    e.stopPropagation();
                    verifyIptvSearchChannel(ch, verifyBtn, statusBadge);
                };

                const testBtn = document.createElement('button');
                testBtn.className = 'btn btn-secondary';
                testBtn.style.padding = '6px 10px';
                testBtn.style.fontSize = '11px';
                testBtn.textContent = '🔗 Test';
                testBtn.onclick = (e) => {
                    e.stopPropagation();
                    testCardStream(ch.url, ch.name || '');
                };

                const isAlreadyTemp = playlistData && Array.isArray(playlistData.streams) && playlistData.streams.some(s => s && s.url === ch.url && s.schedule_type === 'temporary' && isStreamForTempWindow(s, currentTempSearchWindow));
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.style.padding = '6px 12px';
                addBtn.style.fontSize = '12px';
                addBtn.style.fontWeight = '600';
                addBtn.style.borderRadius = '6px';
                addBtn.style.cursor = 'pointer';
                addBtn.style.border = '1px solid #2563eb';
                addBtn.style.background = '#2563eb';
                addBtn.style.color = '#ffffff';

                if (isAlreadyTemp) {
                    addBtn.textContent = `✓ In Win ${currentTempSearchWindow}`;
                    addBtn.style.background = '#dcfce7';
                    addBtn.style.borderColor = '#86efac';
                    addBtn.style.color = '#15803d';
                } else {
                    addBtn.textContent = `+ Add to Window ${currentTempSearchWindow}`;
                }

                addBtn.onclick = () => {
                    addChannelToTempWindow(ch, currentTempSearchWindow, addBtn);
                };

                btnContainer.appendChild(verifyBtn);
                btnContainer.appendChild(testBtn);
                btnContainer.appendChild(addBtn);

                item.appendChild(label);
                item.appendChild(btnContainer);
                fragment.appendChild(item);
            });

            resultsContainer.appendChild(fragment);

            if (data.length > 100) {
                const countNote = document.createElement('div');
                countNote.style.color = 'var(--muted)';
                countNote.style.fontSize = '12px';
                countNote.style.padding = '8px';
                countNote.style.textAlign = 'center';
                countNote.textContent = `Showing top 100 of ${data.length} channels from all providers. Refine query to narrow down.`;
                resultsContainer.appendChild(countNote);
            }
        }

        function renderTempYouTubeResults(results) {
            const resultsContainer = document.getElementById('temp-search-modal-results');
            if (!resultsContainer) return;
            resultsContainer.innerHTML = '';

            const fragment = document.createDocumentFragment();

            results.forEach(video => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.justifyContent = 'space-between';
                item.style.alignItems = 'center';
                item.style.padding = '10px 14px';
                item.style.background = '#ffffff';
                item.style.border = '1px solid var(--line)';
                item.style.borderRadius = '10px';
                item.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                item.style.gap = '12px';

                const thumbBox = document.createElement('div');
                thumbBox.style.position = 'relative';
                thumbBox.style.width = '90px';
                thumbBox.style.height = '52px';
                thumbBox.style.borderRadius = '6px';
                thumbBox.style.overflow = 'hidden';
                thumbBox.style.flexShrink = '0';
                thumbBox.style.background = '#000000';

                const img = document.createElement('img');
                img.src = video.thumbnail;
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'cover';
                thumbBox.appendChild(img);

                if (video.is_live) {
                    const liveBadge = document.createElement('span');
                    liveBadge.style.position = 'absolute';
                    liveBadge.style.bottom = '4px';
                    liveBadge.style.left = '4px';
                    liveBadge.style.background = '#dc2626';
                    liveBadge.style.color = '#ffffff';
                    liveBadge.style.fontSize = '9px';
                    liveBadge.style.fontWeight = '700';
                    liveBadge.style.padding = '1px 5px';
                    liveBadge.style.borderRadius = '3px';
                    liveBadge.textContent = '🔴 LIVE';
                    thumbBox.appendChild(liveBadge);
                }

                const meta = document.createElement('div');
                meta.style.flex = '1';
                meta.style.minWidth = '0';

                const titleEl = document.createElement('div');
                titleEl.style.fontWeight = '700';
                titleEl.style.fontSize = '13px';
                titleEl.style.color = 'var(--ink)';
                titleEl.style.whiteSpace = 'nowrap';
                titleEl.style.overflow = 'hidden';
                titleEl.style.textOverflow = 'ellipsis';
                titleEl.textContent = video.title;
                meta.appendChild(titleEl);

                const channelEl = document.createElement('div');
                channelEl.style.fontSize = '11px';
                channelEl.style.color = 'var(--muted)';
                channelEl.textContent = `${video.channel || 'YouTube'} • ▶️ Live Stream`;
                meta.appendChild(channelEl);

                const btnContainer = document.createElement('div');
                btnContainer.style.display = 'flex';
                btnContainer.style.gap = '6px';
                btnContainer.style.alignItems = 'center';
                btnContainer.style.flexShrink = '0';

                const testBtn = document.createElement('button');
                testBtn.className = 'btn btn-secondary';
                testBtn.style.padding = '6px 10px';
                testBtn.style.fontSize = '11px';
                testBtn.textContent = '🔗 Preview';
                testBtn.onclick = (e) => {
                    e.stopPropagation();
                    testCardStream(video.embed_url || `https://www.youtube.com/embed/${video.videoId}`, video.title);
                };

                const isAlreadyTemp = playlistData && Array.isArray(playlistData.streams) && playlistData.streams.some(s => s && s.url && s.url.includes(video.videoId) && s.schedule_type === 'temporary' && isStreamForTempWindow(s, currentTempSearchWindow));
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.style.padding = '6px 12px';
                addBtn.style.fontSize = '12px';
                addBtn.style.fontWeight = '600';
                addBtn.style.borderRadius = '6px';
                addBtn.style.cursor = 'pointer';
                addBtn.style.border = '1px solid #dc2626';
                addBtn.style.background = '#dc2626';
                addBtn.style.color = '#ffffff';

                if (isAlreadyTemp) {
                    addBtn.textContent = `✓ In Win ${currentTempSearchWindow}`;
                    addBtn.style.background = '#dcfce7';
                    addBtn.style.borderColor = '#86efac';
                    addBtn.style.color = '#15803d';
                } else {
                    addBtn.textContent = `+ Add to Window ${currentTempSearchWindow}`;
                }

                addBtn.onclick = () => {
                    const chObj = {
                        name: video.title,
                        url: video.embed_url || `https://www.youtube.com/embed/${video.videoId}`,
                        category: 'YouTube'
                    };
                    addChannelToTempWindow(chObj, currentTempSearchWindow, addBtn);
                };

                btnContainer.appendChild(testBtn);
                btnContainer.appendChild(addBtn);

                item.appendChild(thumbBox);
                item.appendChild(meta);
                item.appendChild(btnContainer);
                fragment.appendChild(item);
            });

            resultsContainer.appendChild(fragment);
        }

        function addChannelToTempWindow(ch, windowNumber, btnElement) {
            const prefix = windowNumber === 2 ? 'temp-schedule-2-' : 'temp-schedule-';
            const sTime = document.getElementById(prefix + 'start')?.value || '06:00';
            const eTime = document.getElementById(prefix + 'end')?.value || '12:00';
            const sDate = document.getElementById(prefix + 'start-date')?.value || '';
            const eDate = document.getElementById(prefix + 'end-date')?.value || '';

            if (!playlistData.streams) playlistData.streams = [];

            // If already present in this window, clicking toggles removal / deletion
            const existingIdx = playlistData.streams.findIndex(s => s && s.url === ch.url && s.schedule_type === 'temporary' && isStreamForTempWindow(s, windowNumber));
            if (existingIdx !== -1) {
                playlistData.streams.splice(existingIdx, 1);
                isFormModified = true;
                renderCategorizedGrid();
                renderTemporaryChannelsList();
                if (btnElement) {
                    btnElement.style.background = '#2563eb';
                    btnElement.style.borderColor = '#2563eb';
                    btnElement.style.color = '#ffffff';
                    btnElement.textContent = `+ Add to Window ${windowNumber}`;
                }
                return;
            }

            const isYt = (ch.url && (ch.url.includes('youtube.com') || ch.url.includes('youtu.be')));
            const newStream = {
                url: ch.url,
                type: isYt ? 'youtube_embed' : 'generic',
                schedule_type: 'temporary',
                schedule_window: windowNumber,
                start_time: sTime,
                end_time: eTime
            };
            if (ch.name) newStream.name = ch.name;
            if (ch.category) newStream.category = ch.category;
            if (sDate) newStream.start_date = sDate;
            if (eDate) newStream.end_date = eDate;

            playlistData.streams.push(newStream);

            isFormModified = true;
            renderCategorizedGrid();
            renderTemporaryChannelsList();

            if (btnElement) {
                btnElement.style.background = '#dcfce7';
                btnElement.style.borderColor = '#86efac';
                btnElement.style.color = '#15803d';
                btnElement.textContent = `Added to Win ${windowNumber}! ✓`;
                setTimeout(() => {
                    btnElement.textContent = `✓ In Win ${windowNumber} (Click to Remove)`;
                }, 1500);
            }
        }

        function getRotationIntervalSeconds() {
            const input = document.getElementById('rotation-interval');
            const unitSelect = document.getElementById('rotation-interval-unit');
            const val = parseFloat(input ? input.value : 0) || 0;
            const unit = unitSelect ? unitSelect.value : 'minutes';
            if (unit === 'minutes') {
                return Math.max(5, Math.round(val * 60));
            }
            return Math.max(5, Math.round(val));
        }

        function onRotationIntervalInput() {
            const sec = getRotationIntervalSeconds();
            const helper = document.getElementById('rotation-interval-helper');
            const unitSelect = document.getElementById('rotation-interval-unit');
            const unit = unitSelect ? unitSelect.value : 'minutes';
            if (helper) {
                if (unit === 'minutes') {
                    helper.textContent = `= ${sec}s`;
                } else {
                    const mins = (sec / 60).toFixed(1).replace(/\.0$/, '');
                    helper.textContent = `= ${mins}m`;
                }
            }
            if (typeof playlistData !== 'undefined' && playlistData) {
                playlistData.rotation_interval_seconds = sec;
            }
            isFormModified = true;
        }

        function onRotationIntervalUnitChange(newUnit) {
            const input = document.getElementById('rotation-interval');
            const helper = document.getElementById('rotation-interval-helper');
            if (!input) return;
            const currentVal = parseFloat(input.value) || 0;
            if (newUnit === 'minutes') {
                // Was seconds, convert to minutes
                const m = Math.round((currentVal / 60) * 100) / 100;
                input.value = m;
                input.min = "0.1";
                input.step = "any";
                if (helper) helper.textContent = `= ${Math.round(currentVal)}s`;
            } else {
                // Was minutes, convert to seconds
                const s = Math.round(currentVal * 60);
                input.value = s;
                input.min = "5";
                input.step = "1";
                if (helper) {
                    const mins = (s / 60).toFixed(1).replace(/\.0$/, '');
                    helper.textContent = `= ${mins}m`;
                }
            }
        }

        function getPlaylistDataFromUI(validate = false) {
            const rotationInterval = getRotationIntervalSeconds();
            const browserChannel = document.getElementById('browser-channel').value;
            
            if (validate) {
                const streams = playlistData.streams || [];
                for (let i = 0; i < streams.length; i++) {
                    const s = streams[i];
                    if (!s.url || !isValidUrl(s.url)) {
                        alert(`Invalid URL format: "${s.url || ''}". URLs must start with http:// or https://`);
                        return null;
                    }
                }
            }
            
            playlistData.rotation_interval_seconds = rotationInterval;
            playlistData.browser_channel = browserChannel;

            const qhEnabledEl = document.getElementById('quiet-hours-enabled');
            const qhStartEl = document.getElementById('quiet-hours-start');
            const endEl = document.getElementById('quiet-hours-end');

            playlistData.quiet_hours = {
                enabled: qhEnabledEl ? qhEnabledEl.checked : false,
                start_time: (qhStartEl && qhStartEl.value) ? qhStartEl.value : '22:00',
                end_time: (endEl && endEl.value) ? endEl.value : '07:00',
                days: (playlistData.quiet_hours && Array.isArray(playlistData.quiet_hours.days)) ? playlistData.quiet_hours.days : [0, 1, 2, 3, 4, 5, 6]
            };

            const tsEnabledEl = document.getElementById('temp-schedule-enabled');
            const tsStartEl = document.getElementById('temp-schedule-start');
            const tsEndEl = document.getElementById('temp-schedule-end');
            const tsStartDateEl = document.getElementById('temp-schedule-start-date');
            const tsEndDateEl = document.getElementById('temp-schedule-end-date');

            playlistData.temporary_schedule = {
                enabled: tsEnabledEl ? tsEnabledEl.checked : false,
                start_time: (tsStartEl && tsStartEl.value) ? tsStartEl.value : '06:00',
                end_time: (tsEndEl && tsEndEl.value) ? tsEndEl.value : '12:00',
                start_date: (tsStartDateEl && tsStartDateEl.value) ? tsStartDateEl.value : '',
                end_date: (tsEndDateEl && tsEndDateEl.value) ? tsEndDateEl.value : '',
                days: (playlistData.temporary_schedule && Array.isArray(playlistData.temporary_schedule.days)) ? playlistData.temporary_schedule.days : [0, 1, 2, 3, 4, 5, 6]
            };

            const ts2EnabledEl = document.getElementById('temp-schedule-2-enabled');
            const ts2StartEl = document.getElementById('temp-schedule-2-start');
            const ts2EndEl = document.getElementById('temp-schedule-2-end');
            const ts2StartDateEl = document.getElementById('temp-schedule-2-start-date');
            const ts2EndDateEl = document.getElementById('temp-schedule-2-end-date');

            playlistData.temporary_schedule_2 = {
                enabled: ts2EnabledEl ? ts2EnabledEl.checked : false,
                start_time: (ts2StartEl && ts2StartEl.value) ? ts2StartEl.value : '18:00',
                end_time: (ts2EndEl && ts2EndEl.value) ? ts2EndEl.value : '22:00',
                start_date: (ts2StartDateEl && ts2StartDateEl.value) ? ts2StartDateEl.value : '',
                end_date: (ts2EndDateEl && ts2EndDateEl.value) ? ts2EndDateEl.value : '',
                days: (playlistData.temporary_schedule_2 && Array.isArray(playlistData.temporary_schedule_2.days)) ? playlistData.temporary_schedule_2.days : [0, 1, 2, 3, 4, 5, 6]
            };

            const acCheckbox = document.getElementById('anti-collision-enabled');
            playlistData.anti_collision_enabled = acCheckbox ? acCheckbox.checked : (playlistData.anti_collision_enabled !== false);
            
            return playlistData;
        }

        function applyPlaylistDataToUI(data) {
            if (!data) return;
            playlistData = {
                rotation_interval_seconds: parseInt(data.rotation_interval_seconds) || 900,
                browser_channel: data.browser_channel || "chrome",
                anti_collision_enabled: data.anti_collision_enabled !== undefined ? !!data.anti_collision_enabled : true,
                quiet_hours: (data.quiet_hours && typeof data.quiet_hours === 'object') ? {
                    enabled: !!data.quiet_hours.enabled,
                    start_time: data.quiet_hours.start_time || "22:00",
                    end_time: data.quiet_hours.end_time || "07:00",
                    days: Array.isArray(data.quiet_hours.days) ? data.quiet_hours.days : [0, 1, 2, 3, 4, 5, 6]
                } : { enabled: false, start_time: "22:00", end_time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
                temporary_schedule: (data.temporary_schedule && typeof data.temporary_schedule === 'object') ? {
                    enabled: !!data.temporary_schedule.enabled,
                    start_time: data.temporary_schedule.start_time || "06:00",
                    end_time: data.temporary_schedule.end_time || "12:00",
                    start_date: data.temporary_schedule.start_date || "",
                    end_date: data.temporary_schedule.end_date || "",
                    days: Array.isArray(data.temporary_schedule.days) ? data.temporary_schedule.days : [0, 1, 2, 3, 4, 5, 6]
                } : { enabled: false, start_time: "06:00", end_time: "12:00", start_date: "", end_date: "", days: [0, 1, 2, 3, 4, 5, 6] },
                temporary_schedule_2: (data.temporary_schedule_2 && typeof data.temporary_schedule_2 === 'object') ? {
                    enabled: !!data.temporary_schedule_2.enabled,
                    start_time: data.temporary_schedule_2.start_time || "18:00",
                    end_time: data.temporary_schedule_2.end_time || "22:00",
                    start_date: data.temporary_schedule_2.start_date || "",
                    end_date: data.temporary_schedule_2.end_date || "",
                    days: Array.isArray(data.temporary_schedule_2.days) ? data.temporary_schedule_2.days : [0, 1, 2, 3, 4, 5, 6]
                } : { enabled: false, start_time: "18:00", end_time: "22:00", start_date: "", end_date: "", days: [0, 1, 2, 3, 4, 5, 6] },
                streams: Array.isArray(data.streams) ? data.streams : []
            };
            const intervalInput = document.getElementById('rotation-interval');
            const unitSelect = document.getElementById('rotation-interval-unit');
            const helper = document.getElementById('rotation-interval-helper');
            if (intervalInput) {
                const totalSec = playlistData.rotation_interval_seconds;
                const unit = unitSelect ? unitSelect.value : 'minutes';
                if (unit === 'minutes') {
                    intervalInput.value = Math.round((totalSec / 60) * 100) / 100;
                    if (helper) helper.textContent = `= ${totalSec}s`;
                } else {
                    intervalInput.value = totalSec;
                    if (helper) {
                        const mins = (totalSec / 60).toFixed(1).replace(/\.0$/, '');
                        helper.textContent = `= ${mins}m`;
                    }
                }
            }
            const browserInput = document.getElementById('browser-channel');
            if (browserInput) browserInput.value = playlistData.browser_channel;

            const acCheckbox = document.getElementById('anti-collision-enabled');
            if (acCheckbox) acCheckbox.checked = playlistData.anti_collision_enabled;
            updateAntiCollisionBadge(playlistData.anti_collision_enabled);

            const qhEnabledEl = document.getElementById('quiet-hours-enabled');
            if (qhEnabledEl) qhEnabledEl.checked = playlistData.quiet_hours.enabled;
            const qhStartEl = document.getElementById('quiet-hours-start');
            if (qhStartEl) qhStartEl.value = playlistData.quiet_hours.start_time;
            const qhEndEl = document.getElementById('quiet-hours-end');
            if (qhEndEl) qhEndEl.value = playlistData.quiet_hours.end_time;
            updateQuietHoursBadge();

            const tsEnabledEl = document.getElementById('temp-schedule-enabled');
            if (tsEnabledEl) tsEnabledEl.checked = playlistData.temporary_schedule.enabled;
            const tsStartEl = document.getElementById('temp-schedule-start');
            if (tsStartEl) tsStartEl.value = playlistData.temporary_schedule.start_time;
            const tsEndEl = document.getElementById('temp-schedule-end');
            if (tsEndEl) tsEndEl.value = playlistData.temporary_schedule.end_time;
            const tsStartDateEl = document.getElementById('temp-schedule-start-date');
            if (tsStartDateEl) tsStartDateEl.value = playlistData.temporary_schedule.start_date || '';
            const tsEndDateEl = document.getElementById('temp-schedule-end-date');
            if (tsEndDateEl) tsEndDateEl.value = playlistData.temporary_schedule.end_date || '';

            const ts2EnabledEl = document.getElementById('temp-schedule-2-enabled');
            if (ts2EnabledEl) ts2EnabledEl.checked = playlistData.temporary_schedule_2.enabled;
            const ts2StartEl = document.getElementById('temp-schedule-2-start');
            if (ts2StartEl) ts2StartEl.value = playlistData.temporary_schedule_2.start_time;
            const ts2EndEl = document.getElementById('temp-schedule-2-end');
            if (ts2EndEl) ts2EndEl.value = playlistData.temporary_schedule_2.end_time;
            const ts2StartDateEl = document.getElementById('temp-schedule-2-start-date');
            if (ts2StartDateEl) ts2StartDateEl.value = playlistData.temporary_schedule_2.start_date || '';
            const ts2EndDateEl = document.getElementById('temp-schedule-2-end-date');
            if (ts2EndDateEl) ts2EndDateEl.value = playlistData.temporary_schedule_2.end_date || '';

            updateTemporaryScheduleBadge();

            isFormModified = true;
            renderCategorizedGrid();
        }

        let currentMode = 'visual';

        function switchEditorMode(mode) {
            if (mode === currentMode) return;

            const visualContainer = document.getElementById('visual-editor');
            const jsonContainer = document.getElementById('json-editor');
            const tabVisual = document.getElementById('tab-visual');
            const tabJson = document.getElementById('tab-json');
            const jsonRawTextarea = document.getElementById('json-raw');

            if (mode === 'json') {
                const data = getPlaylistDataFromUI();
                jsonRawTextarea.value = JSON.stringify(data, null, 2);
                
                visualContainer.classList.add('hidden');
                jsonContainer.classList.remove('hidden');
                tabVisual.classList.remove('active');
                tabJson.classList.add('active');
                currentMode = 'json';
            } else {
                try {
                    const jsonText = jsonRawTextarea.value.trim();
                    if (!jsonText) {
                        throw new Error("JSON cannot be empty");
                    }
                    const data = JSON.parse(jsonText);
                    
                    if (data.rotation_interval_seconds !== undefined && isNaN(parseInt(data.rotation_interval_seconds))) {
                        throw new Error("rotation_interval_seconds must be a number");
                    }
                    if (data.streams && !Array.isArray(data.streams)) {
                        throw new Error("streams must be an array");
                    }
                    
                    applyPlaylistDataToUI(data);
                    
                    jsonContainer.classList.add('hidden');
                    visualContainer.classList.remove('hidden');
                    tabVisual.classList.add('active');
                    tabJson.classList.remove('active');
                    currentMode = 'visual';
                } catch (err) {
                    alert('Invalid JSON! Please fix the errors before switching to Visual Mode:\n' + err.message);
                }
            }
        }

        async function savePlaylist(force = false, { stayInPlace = false } = {}) {
            let data = null;

            if (currentMode === 'visual') {
                data = getPlaylistDataFromUI(true);
                if (!data) return; // Abort if validation fails
            } else {
                const jsonRawTextarea = document.getElementById('json-raw');
                try {
                    const jsonText = jsonRawTextarea.value.trim();
                    if (!jsonText) {
                        throw new Error("JSON cannot be empty");
                    }
                    data = JSON.parse(jsonText);
                    
                    if (data.rotation_interval_seconds !== undefined && isNaN(parseInt(data.rotation_interval_seconds))) {
                        throw new Error("rotation_interval_seconds must be a number");
                    }
                    if (data.streams && !Array.isArray(data.streams)) {
                        throw new Error("streams must be an array");
                    }
                    if (data.streams) {
                        for (let s of data.streams) {
                            if (s.url && !isValidUrl(s.url)) {
                                throw new Error(`Invalid URL format: "${s.url}". URLs must start with http:// or https://`);
                            }
                        }
                    }
                } catch (err) {
                    alert('Invalid JSON! Please fix the errors before saving:\n' + err.message);
                    return;
                }
            }

            data.client_id = typeof sessionClientId !== 'undefined' ? sessionClientId : null;
            data.force = force;

            const saveBtn = document.querySelector('button[onclick="savePlaylist()"]');
            const originalText = saveBtn ? saveBtn.textContent : '';
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';
            }

            try {
                const response = await fetch(getApiUrl('api/playlist/save'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                if (result.success) {
                    if (typeof clearDraftFromLocalStorage === 'function') clearDraftFromLocalStorage();
                    if (typeof releaseEditingLock === 'function') releaseEditingLock();
                    if (typeof dismissSyncWarning === 'function') dismissSyncWarning();
                    isFormModified = false;
                    pageLoadPlaylistVersion = result.version;
                    lastUserSaveTimestamp = Date.now();
                    
                    if (saveBtn) {
                        saveBtn.disabled = false;
                        saveBtn.textContent = 'Saved! ✓';
                        saveBtn.style.background = '#059669';
                        setTimeout(() => {
                            saveBtn.textContent = originalText;
                            saveBtn.style.background = '';
                        }, 2500);
                    }
                    showToast('✅ Configuration saved successfully!');

                    const totalBadge = document.getElementById('header-total-channels');
                    if (totalBadge && playlistData && Array.isArray(playlistData.streams)) {
                        totalBadge.textContent = playlistData.streams.length;
                    }

                    // Persist and keep search in view without reload
                    const sInput = document.getElementById('iptv-search-input');
                    const cSelect = document.getElementById('iptv-category-select');
                    if (sInput && sInput.value.trim().length >= 2) {
                        const st = { type: 'query', val: sInput.value.trim() };
                        sessionStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                        localStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                    } else if (cSelect && cSelect.value) {
                        const st = { type: 'category', val: cSelect.value };
                        sessionStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                        localStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                    }

                    const provModal = document.getElementById('provider-channels-modal');
                    if (provModal && provModal.classList.contains('active')) {
                        provModal.focus();
                    } else if (!stayInPlace) {
                        scrollToIptvSearch();
                    }
                } else {
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = originalText; }
                    alert('Error saving configuration: ' + result.error);
                }
            } catch (err) {
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = originalText; }
                alert('Network error saving configuration: ' + err);
            }
        }

        async function forceClientReload() {
            if (!confirm("Are you sure you want to force all active kiosk screens/clients to reload immediately?")) {
                return;
            }
            try {
                const response = await fetch(getApiUrl('api/playlist/request-reload'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                const result = await response.json();
                if (result.success) {
                    alert("Reload request sent to all active clients successfully!");
                } else {
                    alert("Failed to send reload request: " + result.error);
                }
            } catch (err) {
                alert("Network error sending reload request: " + err);
            }
        }

        async function skipToNextStream() {
            try {
                const response = await fetch(getApiUrl('api/playlist/request-skip'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                const result = await response.json();
                if (result.success) {
                    alert("Skip request sent to all active clients successfully!");
                } else {
                    alert("Failed to send skip request: " + result.error);
                }
            } catch (err) {
                alert("Network error sending skip request: " + err);
            }
        }

        function showToast() {
            const toast = document.getElementById('toast');
            toast.style.display = 'block';
            setTimeout(() => {
                toast.style.display = 'none';
            }, 3000);
        }

        function isValidUrl(string) {
            try {
                const url = new URL(string);
                return url.protocol === "http:" || url.protocol === "https:";
            } catch (_) {
                return false;  
            }
        }

        async function fetchActiveSessions() {
            try {
                const res = await fetch(getApiUrl('api/sessions'));
                const data = await res.json();
                
                // Update badge in header
                const badge = document.getElementById('active-sessions-badge');
                if (badge && data && typeof data.count !== 'undefined') {
                    badge.textContent = `Active Sessions: ${data.count}`;
                    badge.style.display = 'inline-block';
                }

                // Update dedicated list section
                const section = document.getElementById('active-sessions-section');
                const countSpan = document.getElementById('active-sessions-count');
                const listDiv = document.getElementById('active-sessions-list');
                
                if (section && countSpan && listDiv) {
                    countSpan.textContent = data.count;
                    if (data.sessions && data.sessions.length > 0) {
                        section.style.display = 'block';
                        listDiv.innerHTML = data.sessions.map(s => `
                            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 10px 15px; border-radius: 8px; font-size: 13px;">
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <span style="color: #60a5fa; font-weight: 600; font-family: monospace;">${s.ip}</span>
                                    <span style="background: rgba(99, 102, 241, 0.2); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3); padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600;">👤 ${s.username || 'default'}</span>
                                    <span style="background: rgba(255,255,255,0.08); padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 500; color: var(--text-secondary);">${s.type}</span>
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px;">
                                    <span style="color: var(--text-secondary); font-size: 11px;">Last active: ${s.last_seen.split(' ')[1]} PT</span>
                                    <button onclick="kickSession('${s.ip}', '${s.username}')" class="btn btn-danger" style="padding: 4px 10px; font-size: 11px; border-radius: 6px; cursor: pointer;">Kick</button>
                                </div>
                            </div>
                        `).join('');
                    } else {
                        section.style.display = 'none';
                        listDiv.innerHTML = '';
                    }
                }
            } catch (err) {
                console.error("Failed to fetch active sessions:", err);
            }
        }

        let livePlayersInterval = null;

        function openLivePlayersModal() {
            const modal = document.getElementById('live-players-modal');
            if (modal) {
                modal.classList.add('active');
                fetchLivePlayers();
                if (!livePlayersInterval) {
                    livePlayersInterval = setInterval(fetchLivePlayers, 5000);
                }
            }
        }

        function closeLivePlayersModal() {
            const modal = document.getElementById('live-players-modal');
            if (modal) {
                modal.classList.remove('active');
            }
            if (livePlayersInterval) {
                clearInterval(livePlayersInterval);
                livePlayersInterval = null;
            }
        }

        async function fetchLivePlayers() {
            try {
                const res = await fetch(getApiUrl('api/players'));
                if (!res.ok) return;
                const data = await res.json();
                const players = data.players || [];
                
                // Update header count badge
                const badgeCount = document.getElementById('header-players-count');
                if (badgeCount) badgeCount.innerText = players.length;
                
                const container = document.getElementById('live-players-list-container');
                if (!container) return;
                
                if (players.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; padding: 35px 20px; color: var(--muted); background: #f8fafc; border-radius: 10px; border: 1px dashed var(--line);">
                            <div style="font-size: 28px; margin-bottom: 8px;">📡</div>
                            <div style="font-size: 14px; font-weight: 700; color: var(--ink);">No Active Players Reporting</div>
                            <div style="font-size: 12px; margin-top: 4px;">Launch a Kiosk (<a href="kiosk?user=${encodeURIComponent(window.IPTV_CONFIG.currentUser || window.IPTV_CONFIG.adminUser || 'admin')}" target="_blank" style="color: var(--accent); font-weight: 600;">kiosk player</a>) or Python rotator to start receiving live playback telemetry.</div>
                        </div>
                    `;
                    return;
                }
                
                let html = '';
                players.forEach(p => {
                    const isPlaying = p.playback_status === 'playing';
                    const statusBadge = isPlaying 
                        ? '<span style="background: #ecfdf5; color: #047857; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; border: 1px solid #a7f3d0; display: inline-flex; align-items: center; gap: 4px;"><span style="width:6px;height:6px;background:#10b981;border-radius:50%;"></span> PLAYING</span>'
                        : `<span style="background: #fffbeb; color: #b45309; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; border: 1px solid #fde68a; text-transform: uppercase;">${escapeHtml(p.playback_status || 'UNKNOWN')}</span>`;
                        
                    const audioBadge = p.muted 
                        ? '<span title="Muted" style="font-size: 12px;">🔇 Muted</span>' 
                        : `<span title="Volume: ${p.volume}%" style="font-size: 12px;">🔊 ${p.volume}%</span>`;
                        
                    const modeBadge = p.shuffle 
                        ? '<span style="background: #f5f3ff; color: #6d28d9; border: 1px solid #ddd6fe; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;">🔀 Shuffle</span>'
                        : '<span style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;">➡️ Sequential</span>';

                    html += `
                        <div style="background: #ffffff; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 1px 3px rgba(16, 24, 40, 0.04);">
                            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <span style="font-size: 16px;">📺</span>
                                    <div>
                                        <div style="font-size: 14px; font-weight: 700; color: var(--ink);">${escapeHtml(p.current_channel)}</div>
                                        <div style="font-size: 11px; color: var(--muted); display: flex; gap: 8px; align-items: center; margin-top: 2px;">
                                            <span>👤 User: <strong style="color: var(--accent);">${escapeHtml(p.playlist_user)}</strong></span>
                                            <span>•</span>
                                            <span>🌐 IP: <strong style="color: var(--ink);">${escapeHtml(p.ip)}</strong></span>
                                            <span>•</span>
                                            <span>💻 ${escapeHtml(p.player_type)}</span>
                                        </div>
                                    </div>
                                </div>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    ${modeBadge}
                                    ${statusBadge}
                                </div>
                            </div>
                            
                            ${p.last_error ? `
                                <div style="background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 6px; padding: 6px 10px; font-size: 11px; display: flex; justify-content: space-between; align-items: center;">
                                    <span>⚠️ <strong>Recent Error:</strong> ${escapeHtml(p.last_error)}</span>
                                    <span style="color: #991b1b; font-size: 10px;">${escapeHtml(p.last_error_time || '')}</span>
                                </div>
                            ` : ''}

                            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--muted); background: #f8fafc; border: 1px solid var(--line); padding: 8px 12px; border-radius: 6px;">
                                <div style="display: flex; gap: 12px; align-items: center;">
                                    ${audioBadge}
                                    <span>⏱️ Interval: <strong>${p.duration_seconds ? (p.duration_seconds >= 60 ? (p.duration_seconds % 60 === 0 ? (p.duration_seconds / 60) + 'm' : Math.floor(p.duration_seconds / 60) + 'm ' + (p.duration_seconds % 60) + 's') : p.duration_seconds + 's') : '--'}</strong></span>
                                    <span>📡 Last Ping: <strong>${escapeHtml(p.last_seen)}</strong></span>
                                </div>
                                <div style="display: flex; gap: 8px; align-items: center;">
                                    <button type="button" class="btn btn-secondary" onclick="openClientLogsModal('${escapeHtml(p.client_id)}')" style="padding: 2px 8px; font-size: 11px; border-radius: 4px; color: #3b82f6;">📋 Logs</button>
                                    ${p.channel_url ? `<a href="${escapeHtml(p.channel_url)}" target="_blank" style="color: var(--accent); text-decoration: none; font-weight: 600;">Stream URL ↗</a>` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                });
                container.innerHTML = html;
                
                const syncEl = document.getElementById('live-players-last-sync');
                if (syncEl) syncEl.innerText = `Updated at ${new Date().toLocaleTimeString()} • Auto-refreshes every 5s`;
            } catch (e) {
                console.error("Failed to fetch live players:", e);
            }
        }

        let clientLogsTimer = null;
        let currentFilterClientId = '';

        function openClientLogsModal(filterClientId = '') {
            currentFilterClientId = filterClientId || '';
            const modal = document.getElementById('client-logs-modal');
            if (modal) {
                modal.classList.add('active');
                fetchClientLogs();
                if (clientLogsTimer) clearInterval(clientLogsTimer);
                clientLogsTimer = setInterval(fetchClientLogs, 4000);
            }
        }

        function closeClientLogsModal() {
            const modal = document.getElementById('client-logs-modal');
            if (modal) modal.classList.remove('active');
            if (clientLogsTimer) {
                clearInterval(clientLogsTimer);
                clientLogsTimer = null;
            }
        }

        async function clearClientLogs() {
            if (!confirm('Clear all buffered client telemetry logs?')) return;
            try {
                await fetch(getApiUrl('api/player/logs'), { method: 'DELETE' });
                fetchClientLogs();
            } catch (e) {}
        }

        async function fetchClientLogs() {
            const container = document.getElementById('client-logs-container');
            if (!container) return;
            const levelSelect = document.getElementById('client-logs-level-filter');
            const level = levelSelect ? levelSelect.value : 'all';
            
            let url = `api/player/logs?limit=150`;
            if (level && level !== 'all') url += `&level=${encodeURIComponent(level)}`;
            if (currentFilterClientId) url += `&client_id=${encodeURIComponent(currentFilterClientId)}`;

            try {
                const res = await fetch(getApiUrl(url));
                if (!res.ok) return;
                const data = await res.json();
                const logs = data.logs || [];
                
                const summary = document.getElementById('client-logs-summary');
                if (summary) {
                    const filterTag = currentFilterClientId ? ` (Client: ${currentFilterClientId})` : '';
                    summary.innerText = `${logs.length} shown (${data.total_buffered} total buffered)${filterTag}`;
                }

                if (logs.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; padding: 35px 20px; color: var(--muted); background: #f8fafc; border-radius: 8px; border: 1px dashed var(--line);">
                            <div style="font-size: 24px; margin-bottom: 6px;">📡</div>
                            <div style="font-size: 13px; font-weight: 700; color: var(--ink);">No Telemetry Logs Recorded</div>
                            <div style="font-size: 11px; margin-top: 2px;">Kiosk clients report errors, stalls, and playback health automatically.</div>
                        </div>
                    `;
                    return;
                }

                let html = '';
                logs.forEach(log => {
                    const isErr = log.level === 'error';
                    const isWarn = log.level === 'warn';
                    const borderCol = isErr ? '#ef4444' : (isWarn ? '#f59e0b' : '#3b82f6');
                    const bgCol = isErr ? 'rgba(239, 68, 68, 0.04)' : (isWarn ? 'rgba(245, 158, 11, 0.04)' : 'rgba(59, 130, 246, 0.03)');
                    const badgeBg = isErr ? '#fee2e2' : (isWarn ? '#fef3c7' : '#dbeafe');
                    const badgeColor = isErr ? '#b91c1c' : (isWarn ? '#b45309' : '#1d4ed8');

                    const timeStr = log.timestamp || log.server_time || '--';
                    const detailsStr = (log.details && Object.keys(log.details).length > 0) ? JSON.stringify(log.details, null, 2) : '';

                    html += `
                        <div style="background: ${bgCol}; border-left: 3px solid ${borderCol}; border-top: 1px solid var(--line); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span style="background: ${badgeBg}; color: ${badgeColor}; font-weight: 700; font-size: 10px; padding: 2px 6px; border-radius: 4px;">${escapeHtml(log.level.toUpperCase())}</span>
                                    <strong style="color: var(--ink); font-size: 12px;">${escapeHtml(log.event)}</strong>
                                    ${log.channel ? `<span style="background: #f1f5f9; color: #475569; padding: 1px 6px; border-radius: 4px; font-size: 11px;">📺 ${escapeHtml(log.channel)}</span>` : ''}
                                </div>
                                <div style="font-size: 11px; color: var(--muted); display: flex; gap: 8px; align-items: center;">
                                    <span>💻 ${escapeHtml(log.client_id || 'unknown')}</span>
                                    <span>•</span>
                                    <span>🌐 ${escapeHtml(log.ip || '')}</span>
                                    <span>•</span>
                                    <span>⏱️ ${escapeHtml(timeStr)}</span>
                                </div>
                            </div>
                            <div style="color: var(--ink); font-size: 12px; margin-top: 2px; word-break: break-word;">
                                ${escapeHtml(log.message)}
                            </div>
                            ${detailsStr ? `
                                <details style="margin-top: 4px;">
                                    <summary style="font-size: 10px; color: var(--accent); cursor: pointer; user-select: none;">Show Details</summary>
                                    <pre style="background: #0f172a; color: #38bdf8; padding: 8px 10px; border-radius: 6px; font-size: 10px; overflow-x: auto; margin-top: 4px; white-space: pre-wrap;">${escapeHtml(detailsStr)}</pre>
                                </details>
                            ` : ''}
                        </div>
                    `;
                });
                container.innerHTML = html;
            } catch (e) {}
        }

        async function kickSession(ip, username) {
            if (!confirm(`Are you sure you want to kick session (${ip} - ${username})?`)) return;
            try {
                const res = await fetch(getApiUrl('api/sessions/kick'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ip, username })
                });
                const data = await res.json();
                if (data.success) {
                    showToast();
                    fetchActiveSessions();
                } else {
                    alert('Failed to kick session: ' + (data.error || 'Unknown error'));
                }
            } catch (e) {
                alert('Error kicking session: ' + e);
            }
        }

        async function kickAllSessions() {
            if (!confirm("Are you sure you want to kick ALL active viewer sessions?")) return;
            try {
                const res = await fetch(getApiUrl('api/sessions/kick'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kick_all: true })
                });
                const data = await res.json();
                if (data.success) {
                    showToast();
                    fetchActiveSessions();
                }
            } catch (e) {
                alert('Error: ' + e);
            }
        }

        let pendingBrokenUrls = [];
        let pendingDuplicateUrls = [];

        function normalizeUrlForDupCheck(u) {
            let val = u.trim().replace(/\/$/, "");
            if (val.includes("youtube.com/watch?v=")) {
                try {
                    const urlObj = new URL(val);
                    const vid = urlObj.searchParams.get("v");
                    if (vid) return `youtube:vid:${vid}`;
                } catch (_) {}
            } else if (val.includes("youtu.be/")) {
                try {
                    const parts = val.split("youtu.be/");
                    if (parts.length > 1) {
                        const vid = parts[1].split("?")[0];
                        if (vid) return `youtube:vid:${vid}`;
                    }
                } catch (_) {}
            } else if (val.includes("youtube.com/embed/")) {
                try {
                    const parts = val.split("youtube.com/embed/");
                    if (parts.length > 1) {
                        const vid = parts[1].split("?")[0];
                        if (vid) return `youtube:vid:${vid}`;
                    }
                } catch (_) {}
            } else if (val.includes("youtube.com/live/")) {
                try {
                    const parts = val.split("youtube.com/live/");
                    if (parts.length > 1) {
                        const vid = parts[1].split("?")[0];
                        if (vid) return `youtube:vid:${vid}`;
                    }
                } catch (_) {}
            }
            return val.toLowerCase();
        }

        async function checkPlaylistValidity() {
            const data = getPlaylistDataFromUI();
            if (!data || !data.streams || data.streams.length === 0) {
                alert("No streams to check!");
                return;
            }

            const modal = document.getElementById('verify-modal');
            const title = document.getElementById('modal-title-text');
            const loading = document.getElementById('modal-loading-indicator');
            const result = document.getElementById('modal-result-content');
            const actionBtn = document.getElementById('modal-action-btn');
            
            const progressText = document.getElementById('progress-status-text');
            const progressBar = document.getElementById('progress-bar-fill');
            const progressUrl = document.getElementById('progress-current-url');
            
            title.textContent = "Checking Playlist Validity...";
            loading.style.display = 'flex';
            result.classList.add('hidden');
            actionBtn.classList.add('hidden');
            modal.classList.add('active');
            
            progressBar.style.width = '0%';
            progressText.textContent = `Initializing check...`;
            progressUrl.textContent = '';
            
            const urls = data.streams.map(s => s.url.trim()).filter(Boolean);
            const total = urls.length;
            let completed = 0;
            pendingBrokenUrls = [];
            pendingDuplicateUrls = [];
            
            const seenUrls = new Set();
            urls.forEach(url => {
                const normalized = normalizeUrlForDupCheck(url);
                if (seenUrls.has(normalized)) {
                    if (!pendingDuplicateUrls.includes(url)) {
                        pendingDuplicateUrls.push(url);
                    }
                } else {
                    seenUrls.add(normalized);
                }
            });

            const limit = 5;
            let index = 0;
            
            async function worker() {
                while (index < urls.length) {
                    const myIndex = index++;
                    const url = urls[myIndex];
                    try {
                        progressUrl.textContent = url;
                        const response = await fetch(getApiUrl(`api/playlist/check-single-url?url=${encodeURIComponent(url)}`));
                        const resData = await response.json();
                        if (!resData.valid) {
                            pendingBrokenUrls.push(url);
                        }
                    } catch (err) {
                        console.error("Failed to check URL:", url, err);
                        pendingBrokenUrls.push(url);
                    } finally {
                        completed++;
                        const pct = Math.round((completed / total) * 100);
                        progressBar.style.width = `${pct}%`;
                        progressText.textContent = `Checking stream ${completed} of ${total} (${pct}%)`;
                    }
                }
            }
            
            const pool = [];
            for (let i = 0; i < Math.min(limit, urls.length); i++) {
                pool.push(worker());
            }
            await Promise.all(pool);
            
            loading.style.display = 'none';
            result.classList.remove('hidden');
            
            renderVerifyModalResult();
        }

        function renderVerifyModalResult() {
            const summaryText = document.getElementById('modal-summary-text');
            const brokenList = document.getElementById('broken-list');
            const title = document.getElementById('modal-title-text');
            const actionBtn = document.getElementById('modal-action-btn');
            const healAllBtn = document.getElementById('btn-modal-verify-heal-all');

            if (pendingBrokenUrls.length === 0 && pendingDuplicateUrls.length === 0) {
                title.textContent = "Playlist is Healthy!";
                summaryText.textContent = "All streams in the playlist are active, valid, and unique. No issues found.";
                brokenList.style.display = 'none';
                if (actionBtn) actionBtn.classList.add('hidden');
                if (healAllBtn) healAllBtn.style.display = 'none';
                return;
            }

            title.textContent = "Issues Detected!";
            let issueSummary = "";
            if (pendingBrokenUrls.length > 0 && pendingDuplicateUrls.length > 0) {
                issueSummary = `Found ${pendingBrokenUrls.length} broken stream(s) and ${pendingDuplicateUrls.length} duplicate stream(s).`;
            } else if (pendingBrokenUrls.length > 0) {
                issueSummary = `Found ${pendingBrokenUrls.length} broken/offline stream(s).`;
            } else {
                issueSummary = `Found ${pendingDuplicateUrls.length} duplicate stream(s).`;
            }
            summaryText.innerHTML = `<strong>${issueSummary}</strong> Use the options below to find working replacement streams, refresh DB, or clean broken channels from your playlist:`;
            
            brokenList.style.display = 'block';
            let listHtml = "";

            if (pendingBrokenUrls.length > 0) {
                listHtml += `<div style="font-weight: 700; color: #ef4444; margin-bottom: 10px; font-size: 13px; display: flex; align-items: center; justify-content: space-between;">
                    <span>🔴 Broken / Offline Channels (${pendingBrokenUrls.length}):</span>
                    <span style="font-size: 11px; font-weight: normal; color: var(--text-secondary);">Click 'Find Fix' to probe channels.db for working stream</span>
                </div>`;
                listHtml += pendingBrokenUrls.map(url => {
                    const s = (playlistData && Array.isArray(playlistData.streams)) ? playlistData.streams.find(item => item && item.url && item.url.trim() === url) : null;
                    const chName = s && s.name ? escapeHtml(s.name) : "Unknown Channel";
                    const chProv = s && typeof getStreamProvider === 'function' ? escapeHtml(getStreamProvider(s)) : (s && s.provider ? escapeHtml(s.provider) : "");
                    const chCat = s && s.category ? escapeHtml(s.category) : "";
                    const encUrl = encodeURIComponent(url);
                    const encName = encodeURIComponent(chName);

                    return `
                        <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span style="font-weight: 700; color: #f87171; font-size: 13px;">📺 ${chName}</span>
                                    ${chProv ? `<span style="font-size: 10px; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; color: #cbd5e1;">${chProv}</span>` : ''}
                                    ${chCat ? `<span style="font-size: 10px; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; color: #94a3b8;">${chCat}</span>` : ''}
                                </div>
                                <button type="button" class="btn btn-secondary" onclick="healSingleModalChannel('${encUrl}', '${encName}')" style="padding: 3px 10px; font-size: 11px; font-weight: 600; color: #93c5fd; background: rgba(59, 130, 246, 0.25); border: 1px solid rgba(59, 130, 246, 0.5); border-radius: 5px; cursor: pointer;" title="Search channels.db for active replacement stream">🔍 Find Fix</button>
                            </div>
                            <div style="font-family: monospace; font-size: 11px; color: #fca5a5; word-break: break-all; background: rgba(0,0,0,0.3); padding: 5px 8px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.2);">
                                ${escapeHtml(url)}
                            </div>
                        </div>
                    `;
                }).join('');
            }

            if (pendingDuplicateUrls.length > 0) {
                if (listHtml) listHtml += `<div style="margin-top: 15px;"></div>`;
                listHtml += `<div style="font-weight: 700; color: #f59e0b; margin-bottom: 8px; font-size: 13px;">🟡 Duplicate Streams (${pendingDuplicateUrls.length}):</div>`;
                listHtml += pendingDuplicateUrls.map(url => {
                    const s = (playlistData && Array.isArray(playlistData.streams)) ? playlistData.streams.find(item => item && item.url && item.url.trim() === url) : null;
                    const chName = s && s.name ? escapeHtml(s.name) : "Duplicate Channel";
                    return `
                        <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 8px 12px; margin-bottom: 6px;">
                            <div style="font-weight: 600; color: #fde047; font-size: 12px; margin-bottom: 4px;">📺 ${chName}</div>
                            <div style="font-family: monospace; font-size: 11px; color: #fde047; word-break: break-all; background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px;">${escapeHtml(url)}</div>
                        </div>
                    `;
                }).join('');
            }

            brokenList.innerHTML = listHtml;

            if (actionBtn) {
                actionBtn.textContent = "🗑️ Clean Broken Channels";
                actionBtn.classList.remove('hidden');
                actionBtn.onclick = () => {
                    removeBrokenFromUI();
                    closeModal();
                };
            }
            if (healAllBtn) {
                healAllBtn.style.display = pendingBrokenUrls.length > 0 ? 'inline-flex' : 'none';
            }
        }
        window.renderVerifyModalResult = renderVerifyModalResult;

        async function healSingleModalChannel(encUrl, encName) {
            const url = decodeURIComponent(encUrl);
            const name = decodeURIComponent(encName);
            if (typeof showToast === 'function') showToast(`🔍 Searching channels.db for active fix for "${name}"...`);
            try {
                const u = (typeof currentUser !== 'undefined' && currentUser && currentUser !== 'default') ? currentUser : ((window.IPTV_CONFIG || {}).adminUser || 'admin');
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/channel/preflight`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, url: url, user: u })
                });
                const data = await res.json();
                if (data.healed && data.url) {
                    if (playlistData && Array.isArray(playlistData.streams)) {
                        const s = playlistData.streams.find(item => item && item.url && item.url.trim() === url);
                        if (s) {
                            s.url = data.url;
                            if (data.provider) s.provider = data.provider;
                            delete s.offline;
                            delete s.is_offline;
                        }
                    }
                    pendingBrokenUrls = pendingBrokenUrls.filter(u => u !== url);
                    if (typeof showToast === 'function') showToast(`✅ Fixed "${name}"! Replaced with: ${data.channel_name || data.url}`);

                    const userParam = u !== 'default' ? `?user=${encodeURIComponent(u)}` : '';
                    await fetch(`${base}api/playlist${userParam}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(playlistData)
                    });

                    renderVerifyModalResult();
                    renderCategorizedGrid();
                } else {
                    if (typeof showToast === 'function') showToast(`❌ No working alternative in DB for "${name}". Try Refresh All DB first.`);
                    else alert(`No working alternative in DB for "${name}". Try Refresh All DB first.`);
                }
            } catch (e) {
                if (typeof showToast === 'function') showToast(`❌ Error healing: ${e.message}`);
            }
        }
        window.healSingleModalChannel = healSingleModalChannel;

        async function healAllBrokenStreamsInModal() {
            const btn = document.getElementById('btn-modal-verify-heal-all');
            if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Auto-healing...'; }
            if (typeof showToast === 'function') showToast('🩺 Probing channels and auto-healing from channels.db...');
            try {
                const base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/playlist/verify`, { method: 'POST' });
                let polls = 0;
                const interval = setInterval(async () => {
                    polls++;
                    try {
                        const sRes = await fetch(`${base}api/playlist/verify-status`);
                        const sData = await sRes.json();
                        if (sData.status === 'done') {
                            clearInterval(interval);
                            if (btn) { btn.disabled = false; btn.innerHTML = '🔍 Find Fix (Auto-Heal All)'; }
                            if (typeof showToast === 'function') showToast(sData.summary || '✅ Auto-heal scan completed!');
                            setTimeout(() => { location.reload(); }, 1200);
                        } else if (sData.status === 'error' || polls > 90) {
                            clearInterval(interval);
                            if (btn) { btn.disabled = false; btn.innerHTML = '🔍 Find Fix (Auto-Heal All)'; }
                            if (typeof showToast === 'function') showToast('❌ Auto-heal scan finished with errors or timeout.');
                        }
                    } catch (e) {
                        console.warn(e);
                    }
                }, 2000);
            } catch (err) {
                if (btn) { btn.disabled = false; btn.innerHTML = '🔍 Find Fix (Auto-Heal All)'; }
                if (typeof showToast === 'function') showToast(`❌ Failed to start auto-heal: ${err.message}`);
            }
        }
        window.healAllBrokenStreamsInModal = healAllBrokenStreamsInModal;

        function removeBrokenFromUI() {
            const urlsToRemove = [...pendingBrokenUrls, ...pendingDuplicateUrls];
            if (!urlsToRemove.length) return;
            
            const initialCount = playlistData.streams.length;
            const seenNormalized = new Set();
            
            playlistData.streams = playlistData.streams.filter(s => {
                const urlVal = s.url ? s.url.trim() : "";
                if (!urlVal) return false;
                
                const normalized = normalizeUrlForDupCheck(urlVal);
                const isBroken = pendingBrokenUrls.includes(urlVal);
                const isDuplicate = pendingDuplicateUrls.includes(urlVal);
                
                if (isBroken || (isDuplicate && seenNormalized.has(normalized))) {
                    return false;
                }
                seenNormalized.add(normalized);
                return true;
            });
            
            const removedCount = initialCount - playlistData.streams.length;
            renderCategorizedGrid();
            
            alert(`Removed ${removedCount} broken/duplicate stream(s) from editor. Please click 'Save Configuration' to persist changes.`);
        }

        function closeModal() {
            document.getElementById('verify-modal').classList.remove('active');
        }

        // Fetch sessions and live players on load and poll periodically
        window.addEventListener('DOMContentLoaded', () => {
            fetchActiveSessions();
            fetchLivePlayers();
            checkAndPromptDraftRestore();
            setInterval(fetchActiveSessions, 10000);
            setInterval(fetchLivePlayers, 10000);
            setInterval(checkServerPlaylistVersion, 3000);
        });

        function testStream(button) {
            const row = button.closest('.stream-item');
            const urlInput = row ? row.querySelector('.stream-url') : null;
            const nameInput = row ? row.querySelector('.stream-name') : null;
            if (urlInput && urlInput.value) {
                const rawUrl = urlInput.value.trim();
                const chName = nameInput ? nameInput.value.trim() : '';
                openTestPlayer(rawUrl, chName);
            } else {
                alert('Please enter a URL first.');
            }
        }

        const sessionClientId = 'client_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
        let editLockHeartbeatTimer = null;

        async function acquireEditingLock() {
            try {
                await fetch(getApiUrl('api/playlist/lock'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: sessionClientId, duration: 900, reason: 'User editing channels in UI' })
                });
            } catch (e) {}
            if (!editLockHeartbeatTimer) {
                editLockHeartbeatTimer = setInterval(async () => {
                    if (isFormModified) {
                        try {
                            await fetch(getApiUrl('api/playlist/lock'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ client_id: sessionClientId, duration: 900 })
                            });
                        } catch (e) {}
                    }
                }, 45000);
            }
        }

        async function releaseEditingLock() {
            try {
                await fetch(getApiUrl('api/playlist/unlock'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: sessionClientId })
                });
            } catch (e) {}
            if (editLockHeartbeatTimer) {
                clearInterval(editLockHeartbeatTimer);
                editLockHeartbeatTimer = null;
            }
        }

        function saveDraftToLocalStorage() {
            try {
                const data = getActivePlaylistData();
                if (data && data.streams && data.streams.length > 0) {
                    localStorage.setItem('stream_iptv_draft_playlist', JSON.stringify({
                        data: data,
                        timestamp: Date.now()
                    }));
                }
            } catch (e) {}
        }

        function clearDraftFromLocalStorage() {
            try {
                localStorage.removeItem('stream_iptv_draft_playlist');
            } catch (e) {}
        }

        let lastUserSaveTimestamp = 0;

        async function checkServerPlaylistVersion() {
            if (Date.now() - lastUserSaveTimestamp < 8000) return;
            try {
                const res = await fetch(getApiUrl('api/playlist/version'));
                const data = await res.json();
                if (data && data.version > pageLoadPlaylistVersion) {
                    if (isFormModified) {
                        // User has active uncommitted edits: NEVER reload or discard their work!
                        showServerOutOfSyncWarning(data.version);
                    } else {
                        // Form clean: show gentle notification pill, NEVER force-reload!
                        showServerUpdateNotice(data.version);
                    }
                }
            } catch (err) {
                console.error("Failed to check server playlist version:", err);
            }
        }

        function showServerUpdateNotice(newVersion) {
            if (document.getElementById('server-update-notice') || document.getElementById('out-of-sync-banner')) return;
            const notice = document.createElement('div');
            notice.id = 'server-update-notice';
            notice.style.position = 'fixed';
            notice.style.top = '15px';
            notice.style.right = '20px';
            notice.style.background = '#1e293b';
            notice.style.border = '1px solid rgba(255,255,255,0.18)';
            notice.style.color = '#f8fafc';
            notice.style.padding = '8px 14px';
            notice.style.borderRadius = '8px';
            notice.style.boxShadow = '0 8px 24px rgba(0,0,0,0.5)';
            notice.style.zIndex = '9999';
            notice.style.fontSize = '12px';
            notice.style.display = 'flex';
            notice.style.alignItems = 'center';
            notice.style.gap = '10px';
            notice.innerHTML = `
                <span>ℹ️ Server playlist updated</span>
                <button class="btn btn-secondary" onclick="location.reload()" style="padding: 3px 8px; font-size: 11px; background: rgba(255,255,255,0.15); color: #fff; border: 1px solid rgba(255,255,255,0.25); border-radius: 4px; cursor: pointer;">Sync</button>
                <button class="btn btn-secondary" onclick="document.getElementById('server-update-notice').remove()" style="padding: 3px 8px; font-size: 11px; background: transparent; color: #94a3b8; border: none; cursor: pointer;">✕</button>
            `;
            document.body.appendChild(notice);
        }

        function showServerOutOfSyncWarning(newVersion) {
            if (document.getElementById('out-of-sync-banner')) return;
            
            const banner = document.createElement('div');
            banner.id = 'out-of-sync-banner';
            banner.style.position = 'fixed';
            banner.style.top = '15px';
            banner.style.left = '50%';
            banner.style.transform = 'translateX(-50%)';
            banner.style.background = '#0f172a';
            banner.style.border = '1px solid #f59e0b';
            banner.style.color = '#f8fafc';
            banner.style.padding = '12px 20px';
            banner.style.borderRadius = '10px';
            banner.style.boxShadow = '0 12px 30px rgba(0, 0, 0, 0.7)';
            banner.style.zIndex = '9999';
            banner.style.fontSize = '13px';
            banner.style.display = 'flex';
            banner.style.flexDirection = 'column';
            banner.style.gap = '8px';
            banner.style.maxWidth = '90vw';
            
            banner.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 16px;">🔒</span>
                    <span style="font-weight: 600; color: #fbbf24;">Server playlist updated in background, but your editing session is locked & safe.</span>
                </div>
                <div style="font-size: 11px; color: #94a3b8;">Your local channel setup is preserved. You can save your edits directly (overwriting server), save as a new profile, or discard.</div>
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap;">
                    <button class="btn btn-primary" onclick="forceSaveMyChanges()" style="padding: 5px 12px; font-size: 12px; font-weight: 700; background: #2563eb; border: 1px solid #3b82f6; border-radius: 6px; color: #fff; cursor: pointer;">💾 Save My Changes (Overwrite)</button>
                    <button class="btn btn-secondary" onclick="openSaveAsModal()" style="padding: 5px 12px; font-size: 12px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25); border-radius: 6px; color: #fff; cursor: pointer;">📁 Save as New Profile...</button>
                    <button class="btn btn-secondary" onclick="dismissSyncWarning()" style="padding: 5px 10px; font-size: 12px; background: transparent; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: #94a3b8; cursor: pointer;">Ignore for Now</button>
                    <button class="btn btn-secondary" onclick="if(confirm('Discard local edits and reload from server?')) location.reload()" style="padding: 5px 10px; font-size: 12px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; color: #fca5a5; cursor: pointer;">Discard & Reload</button>
                </div>
            `;
            
            document.body.appendChild(banner);
        }

        function dismissSyncWarning() {
            const banner = document.getElementById('out-of-sync-banner');
            if (banner) banner.remove();
        }

        async function forceSaveMyChanges() {
            dismissSyncWarning();
            await savePlaylist(true);
        }

        function checkAndPromptDraftRestore() {
            try {
                const saved = localStorage.getItem('stream_iptv_draft_playlist');
                if (!saved) return;
                const draftObj = JSON.parse(saved);
                if (draftObj && draftObj.data && draftObj.timestamp) {
                    const ageMinutes = Math.round((Date.now() - draftObj.timestamp) / 60000);
                    if (ageMinutes > 1440) {
                        localStorage.removeItem('stream_iptv_draft_playlist');
                        return;
                    }
                    if (document.getElementById('draft-restore-banner')) return;
                    const bar = document.createElement('div');
                    bar.id = 'draft-restore-banner';
                    bar.style.position = 'fixed';
                    bar.style.bottom = '20px';
                    bar.style.right = '20px';
                    bar.style.background = '#0f172a';
                    bar.style.border = '1px solid #3b82f6';
                    bar.style.color = '#fff';
                    bar.style.padding = '12px 18px';
                    bar.style.borderRadius = '8px';
                    bar.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
                    bar.style.zIndex = '9999';
                    bar.style.fontSize = '12px';
                    bar.innerHTML = `
                        <div style="font-weight: 600; margin-bottom: 6px; color: #60a5fa;">📋 Unsaved channel setup draft found (${ageMinutes}m ago)</div>
                        <div style="font-size: 11px; color: #94a3b8; margin-bottom: 8px;">You have uncommitted changes from an earlier editing session.</div>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-primary" onclick="restoreDraftData()" style="padding: 4px 10px; font-size: 11px; background: #2563eb; color: #fff; border: 1px solid #3b82f6; border-radius: 4px; cursor: pointer;">Restore Draft</button>
                            <button class="btn btn-secondary" onclick="clearDraftFromLocalStorage(); document.getElementById('draft-restore-banner').remove();" style="padding: 4px 10px; font-size: 11px; background: rgba(255,255,255,0.1); color: #94a3b8; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer;">Discard</button>
                        </div>
                    `;
                    document.body.appendChild(bar);
                }
            } catch (e) {}
        }

        function restoreDraftData() {
            try {
                const saved = localStorage.getItem('stream_iptv_draft_playlist');
                if (!saved) return;
                const draftObj = JSON.parse(saved);
                if (draftObj && draftObj.data) {
                    playlistData = draftObj.data;
                    streams = draftObj.data.streams || [];
                    isFormModified = true;
                    if (currentMode === 'visual') {
                        renderCategorizedGrid();
                    } else {
                        const jsonRawTextarea = document.getElementById('json-raw');
                        if (jsonRawTextarea) jsonRawTextarea.value = JSON.stringify(draftObj.data, null, 2);
                    }
                    const bar = document.getElementById('draft-restore-banner');
                    if (bar) bar.remove();
                    showToast('Draft restored successfully!');
                }
            } catch (e) {
                alert('Could not restore draft: ' + e.message);
            }
        }

        function toggleMiniPreview(container) {
            // Deprecated inline preview since visual editor uses modal card actions.
        }

        function getActivePlaylistData() {
            let data = currentMode === 'visual' ? getPlaylistDataFromUI(false) : null;
            if (!data) {
                const jsonRawTextarea = document.getElementById('json-raw');
                try { data = JSON.parse(jsonRawTextarea.value.trim()); } catch(e) {}
            }
            if (!data) data = playlistData;
            return data;
        }

        async function openSaveAsModal() {
            const modal = document.getElementById('save-as-modal');
            const input = document.getElementById('save-as-name-input');
            const select = document.getElementById('save-as-preset-select');
            if (modal) modal.classList.add('active');

            // Populate existing profiles dropdown
            if (select) {
                select.innerHTML = '<option value="">Clone / Overwrite Existing...</option>';
                try {
                    let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                    const res = await fetch(`${base}api/playlist/list`);
                    const listData = await res.json();
                    if (listData.success && Array.isArray(listData.playlists)) {
                        listData.playlists.forEach(p => {
                            const opt = document.createElement('option');
                            opt.value = p.name;
                            opt.textContent = `${p.name} (${p.channel_count || 0} ch)`;
                            select.appendChild(opt);
                        });
                    }
                } catch(e) {}
            }

            if (input) {
                input.value = currentUser && currentUser !== 'default' ? `${currentUser}_custom` : 'my_playlist';
                setTimeout(() => { input.focus(); input.select(); }, 50);
            }

            onSaveDestinationChange();
            updateSaveAsPreview();
        }

        function closeSaveAsModal() {
            const modal = document.getElementById('save-as-modal');
            if (modal) modal.classList.remove('active');

            const provModal = document.getElementById('provider-channels-modal');
            if (provModal && provModal.classList.contains('active')) {
                provModal.focus();
            } else {
                const sInput = document.getElementById('iptv-search-input');
                const cSelect = document.getElementById('iptv-category-select');
                if ((sInput && sInput.value.trim().length >= 2) || (cSelect && cSelect.value)) {
                    scrollToIptvSearch();
                }
            }
        }

        function onSaveDestinationChange() {
            const dest = document.querySelector('input[name="save-destination"]:checked')?.value || 'server';
            const serverOptions = document.getElementById('save-server-options');
            const localOptions = document.getElementById('save-local-options');
            const cardServer = document.getElementById('dest-card-server');
            const cardLocal = document.getElementById('dest-card-local');
            const submitBtn = document.getElementById('save-as-submit-btn');

            if (dest === 'server') {
                if (serverOptions) serverOptions.style.display = 'block';
                if (localOptions) localOptions.style.display = 'none';
                if (cardServer) {
                    cardServer.style.background = 'rgba(99, 102, 241, 0.12)';
                    cardServer.style.borderColor = '#6366f1';
                }
                if (cardLocal) {
                    cardLocal.style.background = 'rgba(255, 255, 255, 0.02)';
                    cardLocal.style.borderColor = 'var(--border-color)';
                }
                if (submitBtn) submitBtn.textContent = '💾 Save to Server Profile';
            } else {
                if (serverOptions) serverOptions.style.display = 'block'; // Keep name input visible for download filename
                if (localOptions) localOptions.style.display = 'block';
                if (cardServer) {
                    cardServer.style.background = 'rgba(255, 255, 255, 0.02)';
                    cardServer.style.borderColor = 'var(--border-color)';
                }
                if (cardLocal) {
                    cardLocal.style.background = 'rgba(16, 185, 129, 0.12)';
                    cardLocal.style.borderColor = '#10b981';
                }
                if (submitBtn) submitBtn.textContent = '⬇️ Download File';
            }
            updateSaveAsPreview();
        }

        function onSelectExistingProfile(val) {
            if (!val) return;
            const input = document.getElementById('save-as-name-input');
            if (input) {
                input.value = val;
                updateSaveAsPreview();
            }
        }

        function getPlaylistListTypeConfig() {
            const listType = document.querySelector('input[name="playlist-list-type"]:checked')?.value || 'permanent';
            const categoryInput = document.getElementById('save-as-category-input');
            const category = categoryInput ? categoryInput.value.trim() : '';
            const startDateInput = document.getElementById('save-as-start-date');
            const endDateInput = document.getElementById('save-as-end-date');
            const startTimeInput = document.getElementById('save-as-start-time');
            const endTimeInput = document.getElementById('save-as-end-time');
            const expirationInput = document.getElementById('save-as-expire-datetime');
            let expiresAt = null;

            if (listType === 'temporary') {
                let expiresValue = expirationInput ? expirationInput.value : '';
                if (expiresValue) {
                    try {
                        expiresAt = new Date(expiresValue).toISOString();
                    } catch(e) {}
                }
            }

            return {
                list_type: listType,
                category: category || undefined,
                start_date: (startDateInput && startDateInput.value) ? startDateInput.value : undefined,
                end_date: (endDateInput && endDateInput.value) ? endDateInput.value : undefined,
                start_time: (startTimeInput && startTimeInput.value) ? startTimeInput.value : undefined,
                end_time: (endTimeInput && endTimeInput.value) ? endTimeInput.value : undefined,
                expires_at: expiresAt
            };
        }

        function updateSaveAsPreview() {
            const input = document.getElementById('save-as-name-input');
            const dest = document.querySelector('input[name="save-destination"]:checked')?.value || 'server';
            const fmt = document.querySelector('input[name="download-format"]:checked')?.value || 'yaml';
            const listType = document.querySelector('input[name="playlist-list-type"]:checked')?.value || 'permanent';
            const expirationRow = document.getElementById('save-as-expiration-row');
            const expirationInput = document.getElementById('save-as-expire-datetime');
            const clean = ((input ? input.value : '') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'playlist';

            const filenameEl = document.getElementById('save-as-filename');
            const kioskUrlEl = document.getElementById('save-as-kiosk-url');
            const kioskRow = document.getElementById('save-as-kiosk-row');
            const channelsCountEl = document.getElementById('save-as-channels-count');

            if (expirationRow) {
                expirationRow.style.display = listType === 'temporary' ? 'block' : 'none';
            }
            if (listType === 'temporary' && expirationInput && !expirationInput.value) {
                const now = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                expirationInput.value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            }

            const ext = (dest === 'server' || fmt === 'yaml') ? '.yaml' : (fmt === 'json' ? '.json' : '.m3u');
            if (filenameEl) filenameEl.textContent = `playlist_${clean}${ext}`;

            if (kioskRow) {
                if (dest === 'server') {
                    kioskRow.style.display = 'block';
                    if (kioskUrlEl) {
                        let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                        kioskUrlEl.textContent = `${base}kiosk?user=${clean}`;
                    }
                } else {
                    kioskRow.style.display = 'none';
                }
            }

            const activeData = getActivePlaylistData();
            if (channelsCountEl && activeData) {
                const count = (activeData.streams || []).length;
                channelsCountEl.textContent = `${count} channels`;
            }
        }

        async function setPlaylistListType(playlistName, listType, expiresAt = null) {
            try {
                let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/playlist/set-list-type`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: playlistName, list_type: listType, expires_at: expiresAt })
                });
                const data = await res.json();
                if (!data.success) {
                    throw new Error(data.error || 'Failed to update playlist list type');
                }
                fetchAndRenderSavedPlaylists();
                const toast = document.getElementById('toast');
                if (toast) {
                    const humanType = listType === 'temporary' ? 'Temporary' : 'Permanent';
                    toast.textContent = `✅ Playlist moved to ${humanType} list.`;
                    toast.style.display = 'block';
                    setTimeout(() => { toast.style.display = 'none'; }, 3000);
                }
            } catch (err) {
                alert('❌ Unable to update playlist type: ' + err.message);
            }
        }

        async function executeSaveAs() {
            const dest = document.querySelector('input[name="save-destination"]:checked')?.value || 'server';
            if (dest === 'local') {
                const fmt = document.querySelector('input[name="download-format"]:checked')?.value || 'yaml';
                downloadPlaylistDirect(fmt);
                closeSaveAsModal();
                return;
            }

            // Save to Server
            const input = document.getElementById('save-as-name-input');
            const name = (input ? input.value : '').trim();
            if (!name) {
                alert('Please enter a playlist / profile name');
                return;
            }

            const cleanName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (!cleanName) {
                alert('Invalid playlist name. Please use letters, numbers, hyphens or underscores.');
                return;
            }

            const data = getActivePlaylistData();
            if (!data) return;

            const submitBtn = document.getElementById('save-as-submit-btn');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Saving...';
            }

            try {
                const listConfig = getPlaylistListTypeConfig();
                let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/playlist/save-as`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: cleanName,
                        playlist: data,
                        category: listConfig.category,
                        list_type: listConfig.list_type,
                        start_date: listConfig.start_date,
                        end_date: listConfig.end_date,
                        start_time: listConfig.start_time,
                        end_time: listConfig.end_time,
                        expires_at: listConfig.expires_at
                    })
                });
                const result = await res.json();
                if (result.success) {
                    closeSaveAsModal();
                    if (typeof dismissSyncWarning === 'function') dismissSyncWarning();
                    if (result.version) {
                        pageLoadPlaylistVersion = result.version;
                    }
                    lastUserSaveTimestamp = Date.now();
                    
                    // Update active profile in memory and URL without reloading page
                    if (typeof currentUser !== 'undefined') {
                        currentUser = cleanName;
                    }
                    window.currentUser = cleanName;
                    try {
                        const newUrl = new URL(window.location.href);
                        newUrl.searchParams.set('user', cleanName);
                        window.history.replaceState({}, '', newUrl);
                    } catch(e) {}

                    isFormModified = false;
                    playlistData = data;
                    window.playlistData = playlistData;

                    // Update header badges and links
                    const userBadges = document.querySelectorAll('.portal-header .status-badge');
                    userBadges.forEach(b => {
                        if (b.textContent.includes('👤')) {
                            b.textContent = `👤 ${cleanName}`;
                        }
                    });
                    const totalBadge = document.getElementById('header-total-channels');
                    if (totalBadge && playlistData && Array.isArray(playlistData.streams)) {
                        totalBadge.textContent = playlistData.streams.length;
                    }
                    const kioskLinks = document.querySelectorAll('a[href*="kiosk?user="]');
                    kioskLinks.forEach(a => { a.href = `kiosk?user=${encodeURIComponent(cleanName)}`; });
                    const viewerLinks = document.querySelectorAll('a[href*="view?user="]');
                    viewerLinks.forEach(a => { a.href = `view?user=${encodeURIComponent(cleanName)}`; });

                    // Save search state to storage
                    const sInput = document.getElementById('iptv-search-input');
                    const cSelect = document.getElementById('iptv-category-select');
                    if (sInput && sInput.value.trim().length >= 2) {
                        const st = { type: 'query', val: sInput.value.trim() };
                        sessionStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                        localStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                    } else if (cSelect && cSelect.value) {
                        const st = { type: 'category', val: cSelect.value };
                        sessionStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                        localStorage.setItem('iptv_provider_search_state', JSON.stringify(st));
                    }

                    showToast(`✅ Saved to profile: playlist_${cleanName}.yaml`);

                    // Return directly to the active search window
                    const provModal = document.getElementById('provider-channels-modal');
                    if (provModal && provModal.classList.contains('active')) {
                        provModal.focus();
                    } else {
                        scrollToIptvSearch();
                    }
                } else {
                    alert('❌ Failed to save playlist: ' + (result.error || 'Unknown error'));
                }
            } catch(err) {
                alert('❌ Network error: ' + err.message);
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '💾 Save to Server Profile';
                }
            }
        }

        function downloadPlaylistDirect(format) {
            const data = getActivePlaylistData();
            if (!data) return;

            const input = document.getElementById('save-as-name-input');
            const cleanName = (input && input.value ? input.value : 'playlist').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'playlist';

            let fileContent = '';
            let mimeType = 'text/plain';
            let fileExt = 'txt';

            if (format === 'json') {
                fileContent = JSON.stringify(data, null, 2);
                mimeType = 'application/json';
                fileExt = 'json';
            } else if (format === 'm3u') {
                fileContent = '#EXTM3U\n';
                (data.streams || []).forEach(s => {
                    const name = s.name || 'Stream Channel';
                    const cat = s.category || 'General';
                    fileContent += `#EXTINF:-1 group-title="${cat}",${name}\n`;
                    fileContent += `${s.url || ''}\n`;
                });
                mimeType = 'audio/x-mpegurl';
                fileExt = 'm3u';
            } else { // YAML default
                fileContent = `rotation_interval_seconds: ${data.rotation_interval_seconds || 900}\n`;
                fileContent += `browser_channel: "${data.browser_channel || 'chrome'}"\n`;
                if (data.quiet_hours && data.quiet_hours.enabled) {
                    fileContent += `quiet_hours:\n`;
                    fileContent += `  enabled: true\n`;
                    fileContent += `  start_time: "${data.quiet_hours.start_time || '22:00'}"\n`;
                    fileContent += `  end_time: "${data.quiet_hours.end_time || '07:00'}"\n`;
                    fileContent += `  days: [${(data.quiet_hours.days || [0, 1, 2, 3, 4, 5, 6]).join(', ')}]\n`;
                }
                fileContent += `streams:\n`;
                (data.streams || []).forEach(s => {
                    fileContent += `- url: "${s.url || ''}"\n`;
                    fileContent += `  type: "${s.type || 'generic'}"\n`;
                    if (s.name) fileContent += `  name: "${s.name.replace(/"/g, '\\"')}"\n`;
                    if (s.category) fileContent += `  category: "${s.category.replace(/"/g, '\\"')}"\n`;
                    if (s.duration_seconds) fileContent += `  duration_seconds: ${s.duration_seconds}\n`;
                });
                mimeType = 'text/yaml';
                fileExt = 'yaml';
            }

            const blob = new Blob([fileContent], { type: mimeType });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `playlist_${cleanName}.${fileExt}`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/[&<>'"]/g, tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag));
        }

        let savedPlaylistsCache = [];

        function openLoadPlaylistModal() {
            const modal = document.getElementById('load-playlist-modal');
            if (modal) modal.classList.add('active');
            const searchInput = document.getElementById('load-playlist-search');
            if (searchInput) {
                searchInput.value = '';
                setTimeout(() => searchInput.focus(), 50);
            }
            onLoadSourceChange();
        }

        function closeLoadPlaylistModal() {
            const modal = document.getElementById('load-playlist-modal');
            if (modal) modal.classList.remove('active');
        }

        function onLoadSourceChange() {
            const src = document.querySelector('input[name="load-source"]:checked')?.value || 'server';
            const serverContainer = document.getElementById('load-server-container');
            const localContainer = document.getElementById('load-local-container');
            const cardServer = document.getElementById('load-src-card-server');
            const cardLocal = document.getElementById('load-src-card-local');

            if (src === 'server') {
                if (serverContainer) serverContainer.style.display = 'block';
                if (localContainer) localContainer.style.display = 'none';
                if (cardServer) {
                    cardServer.style.background = 'rgba(99, 102, 241, 0.12)';
                    cardServer.style.borderColor = '#6366f1';
                }
                if (cardLocal) {
                    cardLocal.style.background = 'rgba(255, 255, 255, 0.02)';
                    cardLocal.style.borderColor = 'var(--border-color)';
                }
                fetchAndRenderSavedPlaylists();
            } else {
                if (serverContainer) serverContainer.style.display = 'none';
                if (localContainer) localContainer.style.display = 'block';
                if (cardServer) {
                    cardServer.style.background = 'rgba(255, 255, 255, 0.02)';
                    cardServer.style.borderColor = 'var(--border-color)';
                }
                if (cardLocal) {
                    cardLocal.style.background = 'rgba(16, 185, 129, 0.12)';
                    cardLocal.style.borderColor = '#10b981';
                }
            }
        }

        let pendingLocalParsedData = null;
        let pendingLocalFileName = '';

        function parseM3uText(m3uText) {
            const lines = m3uText.split(/\r?\n/);
            const streams = [];
            let currentName = 'Stream Channel';
            let currentCat = 'General';

            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                if (line.startsWith('#EXTINF:')) {
                    const groupMatch = line.match(/group-title="([^"]+)"/i);
                    if (groupMatch) currentCat = groupMatch[1];
                    const commaIdx = line.lastIndexOf(',');
                    if (commaIdx !== -1) {
                        currentName = line.substring(commaIdx + 1).trim();
                    }
                } else if (!line.startsWith('#')) {
                    const url = line;
                    const isYt = (url.includes('youtube.com') || url.includes('youtu.be'));
                    streams.push({
                        url: url,
                        name: currentName,
                        category: currentCat,
                        type: isYt ? 'youtube_embed' : 'generic'
                    });
                    currentName = 'Stream Channel';
                    currentCat = 'General';
                }
            }
            return {
                rotation_interval_seconds: 900,
                browser_channel: 'chrome',
                streams: streams
            };
        }

        async function handlePlaylistFileSelect(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            pendingLocalFileName = file.name;

            const nameEl = document.getElementById('selected-file-name');
            const metaEl = document.getElementById('selected-file-meta');
            const infoBox = document.getElementById('selected-file-info-box');
            if (nameEl) nameEl.textContent = file.name;
            if (metaEl) metaEl.textContent = 'Parsing file content...';
            if (infoBox) infoBox.style.display = 'block';

            const reader = new FileReader();
            reader.onload = async function(e) {
                const text = e.target.result;
                try {
                    let parsed = null;
                    if (file.name.endsWith('.json')) {
                        parsed = JSON.parse(text);
                    } else if (file.name.endsWith('.m3u') || file.name.endsWith('.m3u8')) {
                        parsed = parseM3uText(text);
                    } else {
                        let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                        const res = await fetch(`${base}api/playlist/parse-yaml`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ yaml: text })
                        });
                        const resData = await res.json();
                        if (resData.success) {
                            parsed = resData.playlist;
                        } else {
                            throw new Error(resData.error || 'Failed to parse YAML');
                        }
                    }

                    if (parsed && Array.isArray(parsed.streams)) {
                        pendingLocalParsedData = parsed;
                        if (metaEl) metaEl.textContent = `Valid playlist format • ${parsed.streams.length} channel(s) detected • Rotation: ${parsed.rotation_interval_seconds || 900}s`;
                    } else {
                        throw new Error('Missing streams array in file');
                    }
                } catch(err) {
                    pendingLocalParsedData = null;
                    if (metaEl) metaEl.innerHTML = `<span style="color: #f87171;">❌ Parse error: ${escapeHtml(err.message)}</span>`;
                }
            };
            reader.readAsText(file);
        }

        function loadSelectedLocalFile() {
            if (!pendingLocalParsedData || !Array.isArray(pendingLocalParsedData.streams)) {
                alert('Please select a valid playlist file first.');
                return;
            }

            if (isFormModified) {
                if (!confirm(`Load local file "${pendingLocalFileName}" into the editor? Any unsaved changes in your workspace will be replaced.`)) {
                    return;
                }
            }

            applyPlaylistDataToUI(pendingLocalParsedData);
            const jsonRawTextarea = document.getElementById('json-raw');
            if (jsonRawTextarea) jsonRawTextarea.value = JSON.stringify(pendingLocalParsedData, null, 2);
            const totalBadge = document.getElementById('header-total-channels');
            if (totalBadge) totalBadge.textContent = pendingLocalParsedData.streams.length;

            closeLoadPlaylistModal();

            const toast = document.getElementById('toast');
            if (toast) {
                toast.textContent = `📥 Loaded local file "${pendingLocalFileName}" (${pendingLocalParsedData.streams.length} channels)!`;
                toast.style.display = 'block';
                setTimeout(() => { toast.style.display = 'none'; }, 3000);
            }
        }

        let savedPlaylistTypeFilter = 'all';

        function setSavedPlaylistFilter(filterName) {
            savedPlaylistTypeFilter = filterName === 'all' || filterName === 'permanent' || filterName === 'temporary' || filterName === 'both' ? filterName : 'all';
            document.querySelectorAll('.saved-playlist-filter').forEach(btn => {
                const active = btn.dataset.filter === savedPlaylistTypeFilter;
                btn.classList.toggle('active', active);
                btn.style.background = active ? '#e0f2fe' : '';
                btn.style.borderColor = active ? '#7dd3fc' : '';
                btn.style.color = active ? '#0f172a' : '';
            });
            fetchAndRenderSavedPlaylists();
        }

        async function fetchAndRenderSavedPlaylists() {
            const container = document.getElementById('saved-playlists-list');
            if (!container) return;
            container.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px; text-align: center; padding: 20px;">Loading saved playlists...</div>';
            
            try {
                let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/playlist/list?type=${encodeURIComponent(savedPlaylistTypeFilter)}`);
                const data = await res.json();
                if (data.success && Array.isArray(data.playlists)) {
                    savedPlaylistsCache = data.playlists;
                    renderSavedPlaylists(savedPlaylistsCache);
                } else {
                    container.innerHTML = `<div style="color: #f87171; font-size: 13px; padding: 15px;">Failed to load list: ${escapeHtml(data.error || 'Unknown error')}</div>`;
                }
            } catch(e) {
                container.innerHTML = `<div style="color: #f87171; font-size: 13px; padding: 15px;">Network error: ${escapeHtml(e.message)}</div>`;
            }
        }

        function filterSavedPlaylists(query) {
            const q = (query || '').trim().toLowerCase();
            const sourceList = savedPlaylistsCache || [];
            if (!q) {
                renderSavedPlaylists(sourceList);
                return;
            }
            const filtered = sourceList.filter(p => p.name.toLowerCase().includes(q) || p.filename.toLowerCase().includes(q));
            renderSavedPlaylists(filtered);
        }

        function renderSavedPlaylists(playlists) {
            const container = document.getElementById('saved-playlists-list');
            if (!container) return;

            if (!playlists || playlists.length === 0) {
                container.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px; text-align: center; padding: 20px;">No saved playlists found.</div>';
                return;
            }

            container.innerHTML = '';
            playlists.forEach(p => {
                const item = document.createElement('div');
                item.style.background = '#ffffff';
                item.style.border = '1px solid var(--line)';
                item.style.borderRadius = '10px';
                item.style.boxShadow = '0 1px 3px rgba(16, 24, 40, 0.04)';
                item.style.padding = '12px 15px';
                item.style.display = 'flex';
                item.style.justifyContent = 'space-between';
                item.style.alignItems = 'center';
                item.style.gap = '12px';
                item.style.flexWrap = 'wrap';

                const isCurrent = (p.name === currentUser || (currentUser === 'default' && p.name === 'default'));

                const infoCol = document.createElement('div');
                infoCol.style.flex = '1';
                infoCol.style.minWidth = '180px';

                let titleHtml = `<strong style="color: var(--ink); font-size: 14px;">${escapeHtml(p.name)}</strong>`;
                if (p.category) {
                    titleHtml += ` <span style="font-size: 11px; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; padding: 1px 6px; border-radius: 4px; font-weight: 600;">📁 ${escapeHtml(p.category)}</span>`;
                }
                if (isCurrent) {
                    titleHtml += ` <span style="font-size: 10px; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; padding: 1px 6px; border-radius: 4px; font-weight: 600;">ACTIVE PROFILE</span>`;
                }

                const typeLabel = (p.list_type === 'temporary') ? '🕒 Temporary' : '📌 Permanent';
                let schedDetail = '';
                if (p.list_type === 'temporary') {
                    if (p.start_time && p.end_time) {
                        schedDetail += ` • ⏰ ${escapeHtml(p.start_time)}-${escapeHtml(p.end_time)}`;
                    }
                    if (p.start_date || p.end_date) {
                        schedDetail += ` • 📅 ${escapeHtml(p.start_date || '...')}~${escapeHtml(p.end_date || '...')}`;
                    }
                    if (p.expires_at) {
                        schedDetail += ` • Expires ${new Date(p.expires_at).toLocaleString()}`;
                    }
                    const activeBadge = p.is_active_now 
                        ? '<span style="color: #16a34a; font-weight: 700;">🟢 Active Now</span>'
                        : '<span style="color: #d97706; font-weight: 700;">⏳ Inactive</span>';
                    schedDetail += ` [${activeBadge}]`;
                }
                const metaHtml = `
                    <div style="font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                        <span>📄 ${escapeHtml(p.filename)}</span>
                        <span>📺 <strong>${p.channel_count || 0}</strong> ch</span>
                        <span>⏱️ ${p.rotation_interval || 600}s</span>
                        <span>${typeLabel}${schedDetail}</span>
                        ${p.modified ? `<span>🕒 ${p.modified}</span>` : ''}
                    </div>
                `;

                infoCol.innerHTML = titleHtml + metaHtml;

                const actionsCol = document.createElement('div');
                actionsCol.style.display = 'flex';
                actionsCol.style.gap = '8px';
                actionsCol.style.alignItems = 'center';

                const typeToggleBtn = document.createElement('button');
                typeToggleBtn.className = 'btn btn-secondary';
                typeToggleBtn.style.padding = '6px 10px';
                typeToggleBtn.style.fontSize = '11px';
                typeToggleBtn.textContent = p.list_type === 'temporary' ? '📌 Make Permanent' : '🕒 Make Temporary';
                typeToggleBtn.title = p.list_type === 'temporary' ? 'Move this playlist to the permanent list' : 'Move this playlist to the temporary list with a 7-day expiration';
                typeToggleBtn.onclick = () => setPlaylistListType(p.name, p.list_type === 'temporary' ? 'permanent' : 'temporary', p.list_type === 'temporary' ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
                actionsCol.appendChild(typeToggleBtn);

                if (p.list_type === 'temporary') {
                    const extendBtn = document.createElement('button');
                    extendBtn.className = 'btn btn-secondary';
                    extendBtn.style.padding = '6px 10px';
                    extendBtn.style.fontSize = '11px';
                    extendBtn.style.background = '#fef3c7';
                    extendBtn.style.borderColor = '#fbbf24';
                    extendBtn.style.color = '#92400e';
                    extendBtn.textContent = '⏰ +7 Days';
                    extendBtn.title = 'Extend the temporary playlist expiration by one week';
                    extendBtn.onclick = () => setPlaylistListType(p.name, 'temporary', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
                    actionsCol.appendChild(extendBtn);
                }

                // Load into Editor Button
                const loadBtn = document.createElement('button');
                loadBtn.className = 'btn btn-secondary';
                loadBtn.style.padding = '6px 12px';
                loadBtn.style.fontSize = '12px';
                loadBtn.style.background = '#ecfdf5';
                loadBtn.style.borderColor = '#a7f3d0';
                loadBtn.style.color = '#047857';
                loadBtn.textContent = '📥 Load into Editor';
                loadBtn.title = 'Load streams from this playlist into current editor';
                loadBtn.onclick = () => loadPlaylistIntoEditor(p.name);

                // Switch Profile Button
                const switchBtn = document.createElement('button');
                switchBtn.className = 'btn btn-secondary';
                switchBtn.style.padding = '6px 12px';
                switchBtn.style.fontSize = '12px';
                switchBtn.style.background = '#eff6ff';
                switchBtn.style.borderColor = '#bfdbfe';
                switchBtn.style.color = '#1d4ed8';
                switchBtn.textContent = '🚀 Switch Profile';
                switchBtn.title = 'Switch active URL context to this user';
                switchBtn.onclick = () => switchToUserPlaylist(p.name);

                actionsCol.appendChild(loadBtn);
                actionsCol.appendChild(switchBtn);

                if (!p.is_protected) {
                    const delBtn = document.createElement('button');
                    delBtn.className = 'btn btn-danger';
                    delBtn.style.padding = '6px 10px';
                    delBtn.style.fontSize = '12px';
                    delBtn.textContent = '🗑️';
                    delBtn.title = 'Delete saved playlist';
                    delBtn.onclick = () => deleteSavedPlaylist(p.name);
                    actionsCol.appendChild(delBtn);
                }

                item.appendChild(infoCol);
                item.appendChild(actionsCol);
                container.appendChild(item);
            });
        }

        async function loadPlaylistIntoEditor(playlistName) {
            if (isFormModified) {
                if (!confirm(`Load playlist "${playlistName}" into the editor? Any unsaved changes in your current view will be replaced.`)) {
                    return;
                }
            }

            try {
                let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/playlist?user=${encodeURIComponent(playlistName)}&mode=edit`);
                const data = await res.json();
                if (data && Array.isArray(data.streams)) {
                    applyPlaylistDataToUI(data);
                    const jsonRawTextarea = document.getElementById('json-raw');
                    if (jsonRawTextarea) {
                        jsonRawTextarea.value = JSON.stringify(data, null, 2);
                    }
                    const totalBadge = document.getElementById('header-total-channels');
                    if (totalBadge) totalBadge.textContent = data.streams.length;
                    
                    closeLoadPlaylistModal();
                    
                    const toast = document.getElementById('toast');
                    if (toast) {
                        toast.textContent = `📥 Loaded playlist "${playlistName}" (${data.streams.length} channels) into editor!`;
                        toast.style.display = 'block';
                        setTimeout(() => { toast.style.display = 'none'; }, 3000);
                    }
                } else {
                    alert('❌ Failed to load playlist content: ' + (data.error || 'Invalid response structure'));
                }
            } catch(e) {
                alert('❌ Error loading playlist: ' + e.message);
            }
        }

        function switchToUserPlaylist(playlistName) {
            let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
            window.location.href = `${base}?user=${encodeURIComponent(playlistName)}`;
        }

        async function deleteSavedPlaylist(playlistName) {
            if (!confirm(`Are you sure you want to permanently delete playlist "${playlistName}"?`)) {
                return;
            }

            try {
                let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
                const res = await fetch(`${base}api/playlist/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: playlistName })
                });
                const data = await res.json();
                if (data.success) {
                    fetchAndRenderSavedPlaylists();
                } else {
                    alert('❌ Failed to delete playlist: ' + (data.error || 'Unknown error'));
                }
            } catch(e) {
                alert('❌ Error deleting playlist: ' + e.message);
            }
        }

        function logoutSession() {
            try {
                localStorage.clear();
                sessionStorage.clear();
            } catch(e) {}

            let base = window.location.pathname.startsWith('/stream-iptv') ? '/stream-iptv/' : '/';
            window.location.href = base + "logout";
        }

// Re-pull the TV guide (EPG) now instead of waiting for the 12-hour refresh
async function refreshTvGuide(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    try {
        const res = await fetch(getApiUrl('api/epg/refresh'), { method: 'POST' });
        const data = await res.json();
        btn.textContent = data.status === 'running' ? '🗓 Guide refresh already running' : '🗓 Guide refresh started (~1 min)';
    } catch (e) {
        btn.textContent = '🗓 Guide refresh failed';
    }
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 5000);
}
