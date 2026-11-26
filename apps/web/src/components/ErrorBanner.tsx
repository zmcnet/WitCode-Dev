interface Props {
  message: string | null;
  onClose: () => void;
}

export function ErrorBanner({ message, onClose }: Props) {
  if (!message) return null;

  return (
    <div className="error-banner" role="alert">
      <span className="error-banner-icon">!</span>
      <span className="error-banner-text">{message}</span>
      <button type="button" onClick={onClose} aria-label="关闭错误提示">
        ×
      </button>
    </div>
  );
}
