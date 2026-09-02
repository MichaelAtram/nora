import type { ReactNode } from "react";
import { useAuthBootstrap } from "./AuthBootstrapProvider";

export function SignupGate({ children }: { children: ReactNode }) {
  const { status } = useAuthBootstrap();

  return status?.signupEnabled === true ? children : null;
}
