import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  public handleRetry = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render() {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <div className={styles.errorBoundary}>
          <div className={styles.errorIcon}>⚠️</div>
          <div className={styles.errorTitle}>Something Went Wrong</div>
          <div className={styles.errorMessage}>
            {error?.message || 'An unexpected error occurred'}
          </div>
          <button className={styles.retryButton} onClick={this.handleRetry}>
            Reload Application
          </button>
        </div>
      );
    }

    return children;
  }
}

export default ErrorBoundary;
