export type CodexLoginMode = "browser" | "device";
export interface CodexDeviceCodeProgress {
  profileId: string;
  userCode: string;
  verificationUrl: string;
}
export const CODEX_LOGIN_PROGRESS_CHANNEL = "anycode:codex-login-progress";
