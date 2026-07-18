import { AuthGate } from "@/components/AuthGate";
import { Dashboard } from "@/components/Dashboard";

export function App() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}
