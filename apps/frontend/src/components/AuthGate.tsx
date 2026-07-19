import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthStatus, login } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CornerBrackets } from "@/components/ui/corner-brackets";
import { Input } from "@/components/ui/input";

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["auth-status"],
    queryFn: getAuthStatus,
  });

  useEffect(() => {
    document.title = data?.serverName ? `${data.serverName} — Open Log` : "Open Log";
  }, [data?.serverName]);

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: () => {
      queryClient.setQueryData(["auth-status"], { authenticated: true });
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    loginMutation.mutate(password);
  };

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center bg-background" />;
  }

  if (!data?.authenticated) {
    return (
      <div className="dot-grid-bg flex h-screen items-center justify-center bg-background text-foreground">
        <CornerBrackets className="p-1">
          <Card className="w-80 border-border">
            <CardHeader>
              <CardTitle className="label-caps text-foreground">
                OPEN LOG <span className="text-muted-foreground">// {data?.serverName || "TIMELINE"}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <label className="label-caps" htmlFor="access-password">
                  Access password
                </label>
                <Input
                  id="access-password"
                  type="password"
                  autoFocus
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="focus-visible:ring-primary"
                />
                {loginMutation.isError && (
                  <p className="text-sm text-destructive">{(loginMutation.error as Error).message}</p>
                )}
                <Button
                  type="submit"
                  disabled={loginMutation.isPending || password.length === 0}
                  className="uppercase tracking-widest"
                >
                  {loginMutation.isPending ? "Authenticating…" : "Authenticate"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </CornerBrackets>
      </div>
    );
  }

  return <>{children}</>;
}
