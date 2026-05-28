import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import TotpSetup from './pages/TotpSetup';
import TotpVerify from './pages/TotpVerify';
import TenantSelector from './pages/TenantSelector';
import Dashboard from './pages/Dashboard';

import Products from './pages/Products';
import Orders from './pages/Orders';
import AdminTenants from './pages/AdminTenants';
import AdminUsers from './pages/AdminUsers';
import TenantConfig from './pages/TenantConfig';
import Trovaprezzi from './pages/Trovaprezzi';
import Statistiche from './pages/Statistiche';
import FeedOptimizer from './pages/FeedOptimizer';
import Onboarding from './pages/Onboarding';
import AgentChat from './pages/Agent';
import ParetoRule from './pages/ParetoRule';
import RuleOptimizer from './pages/RuleOptimizer';
import CrossChannel from './pages/CrossChannel';
import Shopping from './pages/Shopping';

export default function App() {
  const { loading, needsTenantSelection } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-brand-400 text-xl font-bold">xHUMANPRO</div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/totp-setup" element={<TotpSetup />} />
      <Route path="/totp-verify" element={<TotpVerify />} />

      <Route path="/admin/tenants" element={
        <ProtectedRoute roles={['superadmin']}>
          <AdminTenants />
        </ProtectedRoute>
      } />

      <Route path="/*" element={
        <ProtectedRoute>
          {needsTenantSelection ? (
            <TenantSelector />
          ) : (
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/orders" element={<Orders />} />
<Route path="/products" element={<Products />} />
                <Route path="/trovaprezzi" element={<Trovaprezzi />} />
                <Route path="/statistiche" element={<Statistiche />} />
                <Route path="/optimization" element={<FeedOptimizer />} />
                <Route path="/pareto" element={<ParetoRule />} />
                <Route path="/rule-optimizer" element={<RuleOptimizer />} />
                <Route path="/cross-channel" element={<CrossChannel />} />
                <Route path="/shopping" element={<Shopping />} />
                <Route path="/admin/users" element={
                  <ProtectedRoute roles={['superadmin', 'admin']}><AdminUsers /></ProtectedRoute>
                } />
                <Route path="/agent" element={
                  <ProtectedRoute roles={['superadmin', 'admin']}><AgentChat /></ProtectedRoute>
                } />
                <Route path="/onboarding" element={
                  <ProtectedRoute roles={['superadmin', 'admin']}><Onboarding /></ProtectedRoute>
                } />
                <Route path="/admin/config" element={
                  <ProtectedRoute roles={['superadmin', 'admin']}><TenantConfig /></ProtectedRoute>
                } />
              </Routes>
            </Layout>
          )}
        </ProtectedRoute>
      } />
    </Routes>
  );
}
