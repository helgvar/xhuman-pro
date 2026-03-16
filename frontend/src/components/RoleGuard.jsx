import { useAuth } from '../contexts/AuthContext';

export default function RoleGuard({ roles, children, fallback = null }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return fallback;
  return children;
}
