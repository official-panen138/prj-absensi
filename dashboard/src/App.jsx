import { useState, useEffect, useCallback } from 'react';
import { NAV_ITEMS } from './lib/theme';
import { Badge } from './components/ui';
import { apiFetch } from './lib/api';
import LoginPage from './pages/LoginPage';
import LiveBoardPage from './pages/LiveBoardPage';
import SchedulePage from './pages/SchedulePage';
import StaffPage from './pages/StaffPage';
import SwapRequestsPage from './pages/SwapRequestsPage';
import ReportsPage from './pages/ReportsPage';
import ActivityLogPage from './pages/ActivityLogPage';
import SettingsPage from './pages/SettingsPage';
import TenantsPage from './pages/TenantsPage';

function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 1024);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return mobile;
}

export default function App() {
  const [auth, setAuth] = useState(() => {
    const t = localStorage.getItem('wms_token');
    const u = localStorage.getItem('wms_user');
    if (t && u) try { return { token: t, user: JSON.parse(u) }; } catch (e) {}
    return null;
  });
  const [page, setPage] = useState('live');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tenants, setTenants] = useState([]);
  const [tenantOverride, setTenantOverride] = useState(() => localStorage.getItem('wms_tenant_override') || '');
  const isMobile = useIsMobile();
  const isSuperAdmin = auth?.user?.role === 'super_admin';

  const handleLogin = (data) => {
    localStorage.setItem('wms_token', data.token);
    localStorage.setItem('wms_user', JSON.stringify(data.user));
    localStorage.removeItem('wms_tenant_override');
    setTenantOverride('');
    setAuth({ token: data.token, user: data.user });
  };

  const handleLogout = () => {
    localStorage.removeItem('wms_token');
    localStorage.removeItem('wms_user');
    localStorage.removeItem('wms_tenant_override');
    setAuth(null);
  };

  const switchTenant = (tid) => {
    if (tid) localStorage.setItem('wms_tenant_override', String(tid));
    else localStorage.removeItem('wms_tenant_override');
    setTenantOverride(tid ? String(tid) : '');
    window.location.reload();
  };

  const fetchTenants = useCallback(async () => {
    if (!isSuperAdmin) return;
    try { const r = await apiFetch(auth.token, '/tenants'); setTenants(r.data || []); } catch {}
  }, [auth?.token, isSuperAdmin]);

  useEffect(() => { if (auth) fetchTenants(); }, [auth, fetchTenants]);
  useEffect(() => { window.__forceLogout = handleLogout; return () => { delete window.__forceLogout; }; }, []);

  if (!auth) return <LoginPage onLogin={handleLogin} />;

  const renderPage = () => {
    switch (page) {
      case 'live': return <LiveBoardPage token={auth.token} />;
      case 'schedule': return <SchedulePage token={auth.token} user={auth.user} />;
      case 'staff': return <StaffPage token={auth.token} />;
      case 'swap': return <SwapRequestsPage token={auth.token} />;
      case 'reports': return <ReportsPage token={auth.token} />;
      case 'activity': return <ActivityLogPage token={auth.token} />;
      case 'settings': return <SettingsPage token={auth.token} user={auth.user} />;
      case 'tenants': return <TenantsPage token={auth.token} />;
      default: return <LiveBoardPage token={auth.token} />;
    }
  };

  const SidebarContent = () => (
    <>
      <div style={{padding:'16px 12px',borderBottom:'1px solid rgb(31 41 55)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div>
          <div style={{fontFamily:'monospace',fontWeight:700,fontSize:12,color:'#34d399',letterSpacing:1}}>PNNGROUP</div>
          <div style={{fontSize:10,color:'#6b7280'}}>Workforce</div>
        </div>
        {isMobile && (
          <button onClick={() => setSidebarOpen(false)} style={{background:'transparent',border:'1px solid #374151',borderRadius:6,color:'#9ca3af',width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',fontSize:11}}>✕</button>
        )}
      </div>

      <nav style={{flex:1,padding:'8px 6px',overflowY:'auto'}}>
        {[...NAV_ITEMS, ...(isSuperAdmin ? [{ id: 'tenants', icon: '🏢', label: 'Tenants' }] : [])].map((item) => {
          const active = page === item.id;
          return (
            <button
              key={item.id}
              onClick={() => { setPage(item.id); setSidebarOpen(false); }}
              style={{
                display:'flex',alignItems:'center',gap:10,width:'100%',padding:'10px 12px',borderRadius:8,
                border:'none',cursor:'pointer',marginBottom:2,fontSize:13,whiteSpace:'nowrap',
                background: active ? 'rgba(52,211,153,0.1)' : 'transparent',
                color: active ? '#34d399' : '#6b7280',
                fontWeight: active ? 700 : 400,
                borderLeft: active ? '3px solid #34d399' : '3px solid transparent',
              }}
            >
              <span style={{fontSize:16,flexShrink:0}}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div style={{padding:6,borderTop:'1px solid rgb(31 41 55)'}}>
        <div style={{padding:'8px 12px',marginBottom:6}}>
          <div style={{fontWeight:600,fontSize:13,color:'#f3f4f6'}}>{auth.user?.name || auth.user?.username}</div>
          <Badge color={auth.user?.role === 'admin' ? 'emerald' : 'purple'}>{auth.user?.role?.toUpperCase()}</Badge>
        </div>
        <button onClick={handleLogout} style={{display:'flex',alignItems:'center',gap:8,width:'100%',padding:'10px 12px',borderRadius:8,border:'1px solid rgba(239,68,68,0.2)',background:'transparent',color:'#f87171',cursor:'pointer',fontSize:13,fontWeight:600}}>
          <span>🚪</span><span>Logout</span>
        </button>
      </div>
    </>
  );

  // ========== MOBILE LAYOUT ==========
  if (isMobile) {
    return (
      <div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',maxWidth:'100vw'}}>
        {/* Mobile top bar */}
        <div style={{height:56,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 16px',borderBottom:'1px solid rgb(31 41 55)',background:'rgb(17 24 39)',flexShrink:0}}>
          <button onClick={() => setSidebarOpen(true)} style={{background:'transparent',border:'1px solid #374151',borderRadius:6,color:'#9ca3af',width:36,height:36,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',fontSize:18}}>☰</button>
          <div style={{fontFamily:'monospace',fontWeight:700,fontSize:12,color:'#34d399',letterSpacing:1}}>PNN GROUP</div>
          <div style={{fontSize:11,color:'#34d399',border:'1px solid rgba(52,211,153,0.3)',borderRadius:9999,padding:'2px 8px',fontWeight:600}}>{auth.user?.name}</div>
        </div>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div style={{position:'fixed',inset:0,zIndex:9999}}>
            <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.7)'}} onClick={() => setSidebarOpen(false)} />
            <aside style={{position:'absolute',top:0,left:0,bottom:0,width:260,background:'rgb(17 24 39)',borderRight:'1px solid rgb(31 41 55)',display:'flex',flexDirection:'column',zIndex:10}}>
              <SidebarContent />
            </aside>
          </div>
        )}

        {/* Content */}
        <div style={{flex:1,overflow:'auto'}}>{renderPage()}</div>
      </div>
    );
  }

  // ========== DESKTOP LAYOUT ==========
  return (
    <div style={{height:'100vh',display:'flex',overflow:'hidden'}}>
      {/* Desktop sidebar */}
      <aside style={{width:220,minWidth:220,background:'rgb(17 24 39)',borderRight:'1px solid rgb(31 41 55)',display:'flex',flexDirection:'column',flexShrink:0}}>
        <SidebarContent />
      </aside>

      {/* Main */}
      <main style={{flex:1,display:'flex',flexDirection:'column',minWidth:0,overflow:'hidden'}}>
        {/* Desktop top bar */}
        <div style={{height:48,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',borderBottom:'1px solid rgb(31 41 55)',background:'rgb(17 24 39)',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:'#34d399'}} />
            <span style={{fontSize:11,fontFamily:'monospace',color:'#34d399'}}>SYSTEM_ONLINE</span>
            {isSuperAdmin && tenants.length > 0 && (
              <select
                value={tenantOverride}
                onChange={(e) => switchTenant(e.target.value)}
                style={{marginLeft:12,background:'rgb(31 41 55)',border:'1px solid rgb(55 65 81)',color:'#f3f4f6',fontSize:11,borderRadius:6,padding:'4px 8px',cursor:'pointer'}}
                title="Tenant context (super admin only)"
              >
                <option value="">🌐 All Tenants (global)</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>🏢 {t.name}</option>)}
              </select>
            )}
          </div>
          <div style={{display:'flex',alignItems:'center',gap:16}}>
            <span style={{fontSize:11,color:'#6b7280',fontFamily:'monospace'}}>{new Date().toLocaleDateString('en-US',{weekday:'short',day:'numeric',month:'short',year:'numeric'})}</span>
            <Badge color="emerald">{auth.user?.name}</Badge>
          </div>
        </div>

        <div style={{flex:1,overflow:'hidden'}}>{renderPage()}</div>
      </main>
    </div>
  );
}
