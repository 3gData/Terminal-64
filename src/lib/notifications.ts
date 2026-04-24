// Sonner-backed toast API. Public surface (pushToast/dismissToast) is preserved
// so existing callers don't need to change.
import { toast } from "sonner";

export type ToastType = "success" | "error" | "warning" | "info";

export function pushToast(title: string, body?: string, type?: ToastType): void {
  const opts = body !== undefined ? { description: body } : undefined;
  switch (type) {
    case "success":
      toast.success(title, opts);
      return;
    case "error":
      toast.error(title, opts);
      return;
    case "warning":
      toast.warning(title, opts);
      return;
    case "info":
      toast.info(title, opts);
      return;
    default:
      toast(title, opts);
  }
}

export function dismissToast(id?: string | number): void {
  if (id === undefined) toast.dismiss();
  else toast.dismiss(id);
}
