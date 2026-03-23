import React, { useState, useEffect, useCallback } from 'react';

// ── Set this to your Railway bot URL after deploying ──────────────
const API_URL = process.env.REACT_APP_API_URL || 'https://your-bot.railway.app';
const REFRESH_MS = 15000;

// ── Helpers ───────────────────────────────────────────────────────
const fmt   = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '—');
const fmtTs = ts => ts ? new Date(ts).toLocaleString() : '—';
const pnlColor = v => v > 0 ? '#4ade80' : v < 0 ? '#f87171' : '#9ca3af';

// ── Styles ────────────────────────────────────────────────────────
const S = {
  root: {
    minHeight: '100vh',
    background: '#0f1117',
    color: '#e2e8f0',
    fontFamily: "'DM Mono', 'Courier New', monospace",
    padding: '0',
    margin: '0',
  },
  header: {
    background: '#1a1d2e',
    borderBottom: '1px solid #2d3148',
    padding: '16px 24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: '15px',
    fontWeight: '600',
    color: '#e2e8f0',
    letterSpacing: '0.05em',
  },
  dot: online => ({
    display: 'inline-block',
    width: '8px', height: '8px',
    borderRadius: '50%',
    background: online ? '#4ade80' : '#ef4444',
    marginRight: '6px',
  }),
  status: {
    fontSize: '12px',
    color: '#6b7280',
  },
  body: {
    padding: '24px',
    maxWidth: '1100px',
    margin: '0 auto',
  },
  grid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0,1fr))',
    gap: '12px',
    marginBottom: '20px',
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0,1fr))',
    gap: '12px',
    marginBottom: '20px',
  },
  card: {
    background: '#1a1d2e',
    border: '1px solid #2d3148',
    borderRadius: '10px',
    padding: '16px 20px',
  },
  cardLabel: {
    fontSize: '11px',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '6px',
  },
  cardValue: (color) => ({
    fontSize: '26px',
    fontWeight: '700',
    color: color || '#e2e8f0',
    lineHeight: 1.1,
  }),
  cardSub: {
    fontSize: '11px',
    color: '#4b5563',
    marginTop: '3px',
  },
  sectionTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '10px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '12px',
  },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    borderBottom: '1px solid #2d3148',
    color: '#4b5563',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  td: {
    padding: '9px 10px',
    borderBottom: '1px solid #1e2236',
    color: '#cbd5e1',
    verticalAlign: 'middle',
  },
  badge: (type) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: '600',
    background: type === 'win' ? '#14532d' : type === 'sl' ? '#450a0a' : '#1e3a5f',
    color:      type === 'win' ? '#4ade80' : type === 'sl' ? '#f87171' : '#60a5fa',
  }),
  symBadge: sym => ({
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: '600',
    background: sym.includes('BOOM') ? '#14532d' : '#450a0a',
    color:      sym.includes('BOOM') ? '#4ade80' : '#f87171',
  }),
  winBar: (pct) => ({
    height: '6px',
    borderRadius: '3px',
    background: '#1e2236',
    overflow: 'hidden',
    marginTop: '6px',
  }),
  winFill: (pct) => ({
    height: '100%',
    width: `${pct}%`,
    borderRadius: '3px',
    background: pct >= 60 ? '#4ade80' : pct >= 40 ? '#facc15' : '#f87171',
    transition: 'width 0.5s',
  }),
  error: {
    textAlign: 'center',
    padding: '48px',
    color: '#f87171',
    fontSize: '13px',
  },
  loading: {
    textAlign: 'center',
    padding: '48px',
    color: '#4b5563',
    fontSize: '13px',
  },
  refreshNote: {
    fontSize: '10px',
    color: '#374151',
    textAlign: 'right',
    marginTop: '16px',
  },
};

// ── Stat card ─────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div style={S.card}>
      <div style={S.cardLabel}>{label}</div>
      <div style={S.cardValue(color)}>{value}</div>
      {sub && <div style={S.cardSub}>{sub}</div>}
    </div>
  );
}

// ── Per-symbol row ────────────────────────────────────────────────
function SymbolRow({ row }) {
  const wr = row.total > 0 ? ((row.wins / row.total) * 100).toFixed(1) : '0.0';
  return (
    <tr>
      <td style={S.td}><span style={S.symBadge(row.symbol)}>{row.symbol}</span></td>
      <td style={S.td}>{row.total}</td>
      <td style={S.td} align="center">
        <span style={{ color: '#4ade80' }}>{row.wins}</span>
        {' / '}
        <span style={{ color: '#f87171' }}>{row.losses}</span>
      </td>
      <td style={S.td}>
        <span style={{ color: parseFloat(wr) >= 50 ? '#4ade80' : '#f87171' }}>{wr}%</span>
        <div style={S.winBar(wr)}><div style={S.winFill(wr)} /></div>
      </td>
      <td style={S.td} align="right">
        <span style={{ color: pnlColor(row.pnl), fontWeight: '600' }}>
          {row.pnl >= 0 ? '+' : ''}${fmt(row.pnl)}
        </span>
      </td>
    </tr>
  );
}

// ── Trade row ─────────────────────────────────────────────────────
function TradeRow({ t }) {
  return (
    <tr>
      <td style={S.td}><span style={S.symBadge(t.symbol)}>{t.symbol}</span></td>
      <td style={S.td}>
        <span style={{ color: t.direction === 'BUY' ? '#4ade80' : '#f87171' }}>{t.direction}</span>
      </td>
      <td style={S.td}>{fmt(t.entry_price)}</td>
      <td style={S.td}>{fmt(t.sl_price)}</td>
      <td style={S.td}>{t.signal_prob ? fmt(t.signal_prob, 1) + '%' : '—'}</td>
      <td style={S.td}><span style={S.badge(t.outcome)}>{t.outcome?.toUpperCase()}</span></td>
      <td style={S.td} align="right">
        {t.pnl_usd != null
          ? <span style={{ color: pnlColor(t.pnl_usd), fontWeight: '600' }}>
              {t.pnl_usd >= 0 ? '+' : ''}${fmt(t.pnl_usd)}
            </span>
          : <span style={{ color: '#374151' }}>open</span>}
      </td>
      <td style={S.td} style={{ color: '#374151', fontSize: '11px' }}>{fmtTs(t.opened_at)}</td>
    </tr>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export default function App() {
  const [data, setData]       = useState(null);
  const [error, setError]     = useState(null);
  const [online, setOnline]   = useState(false);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setOnline(true);
      setError(null);
      setLastFetch(new Date().toLocaleTimeString());
    } catch (err) {
      setOnline(false);
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const s = data?.summary;

  return (
    <div style={S.root}>
      <div style={S.header}>
        <div style={S.headerTitle}>
          <span style={S.dot(online)} />
          Boom & Crash — Trade Dashboard
        </div>
        <div style={S.status}>
          {online ? `Live · refreshes every ${REFRESH_MS/1000}s` : '⚠ Cannot reach bot API'}
        </div>
      </div>

      <div style={S.body}>
        {error && !data && (
          <div style={S.error}>
            Cannot connect to bot API.<br />
            Make sure your Railway bot is running and<br />
            <code style={{ color: '#fb923c' }}>REACT_APP_API_URL</code> is set correctly in Vercel.<br /><br />
            <span style={{ color: '#374151' }}>{error}</span>
          </div>
        )}

        {!data && !error && <div style={S.loading}>Loading trade data...</div>}

        {s && (
          <>
            {/* ── Summary cards ── */}
            <div style={S.grid4}>
              <StatCard
                label="Win rate"
                value={`${s.winRate}%`}
                sub={`${s.wins}W / ${s.losses}L`}
                color={s.winRate >= 60 ? '#4ade80' : s.winRate >= 40 ? '#facc15' : '#f87171'}
              />
              <StatCard
                label="Total P&L"
                value={`${s.totalPnl >= 0 ? '+' : ''}$${fmt(s.totalPnl)}`}
                sub={`${s.total} closed trades`}
                color={pnlColor(s.totalPnl)}
              />
              <StatCard
                label="SL hits"
                value={s.losses}
                sub={`$${fmt(s.losses * 1.50)} lost`}
                color={s.losses > 0 ? '#f87171' : '#4b5563'}
              />
              <StatCard
                label="Open trades"
                value={s.open}
                sub="currently active"
                color={s.open > 0 ? '#60a5fa' : '#4b5563'}
              />
            </div>

            {/* ── Best / Worst ── */}
            {(data.best || data.worst) && (
              <div style={S.grid2}>
                {data.best && (
                  <div style={S.card}>
                    <div style={S.cardLabel}>Best trade</div>
                    <div style={S.cardValue('#4ade80')}>+${fmt(data.best.pnl_usd)}</div>
                    <div style={S.cardSub}>{data.best.symbol} · {fmtTs(data.best.opened_at)}</div>
                  </div>
                )}
                {data.worst && (
                  <div style={S.card}>
                    <div style={S.cardLabel}>Worst trade</div>
                    <div style={S.cardValue('#f87171')}>${fmt(data.worst.pnl_usd)}</div>
                    <div style={S.cardSub}>{data.worst.symbol} · {fmtTs(data.worst.opened_at)}</div>
                  </div>
                )}
              </div>
            )}

            {/* ── Per symbol breakdown ── */}
            {data.bySymbol?.length > 0 && (
              <div style={{ ...S.card, marginBottom: '20px' }}>
                <div style={S.sectionTitle}>Performance by symbol</div>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Symbol</th>
                      <th style={S.th}>Trades</th>
                      <th style={S.th}>W / L</th>
                      <th style={S.th}>Win rate</th>
                      <th style={S.th} align="right">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bySymbol.map(row => <SymbolRow key={row.symbol} row={row} />)}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── Recent trades ── */}
            {data.recent?.length > 0 && (
              <div style={S.card}>
                <div style={S.sectionTitle}>Recent trades (last 20)</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        <th style={S.th}>Symbol</th>
                        <th style={S.th}>Dir</th>
                        <th style={S.th}>Entry</th>
                        <th style={S.th}>SL</th>
                        <th style={S.th}>Prob</th>
                        <th style={S.th}>Result</th>
                        <th style={S.th} align="right">P&L</th>
                        <th style={S.th}>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map(t => <TradeRow key={t.id} t={t} />)}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.recent?.length === 0 && (
              <div style={{ ...S.card, textAlign: 'center', color: '#374151', padding: '32px' }}>
                No trades recorded yet. Signals will appear here once the bot fires.
              </div>
            )}

            <div style={S.refreshNote}>Last updated: {lastFetch}</div>
          </>
        )}
      </div>
    </div>
  );
}
