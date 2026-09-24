import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { reportCrash } from '../lib/crashReporter';

interface Props {
  children: ReactNode;
  route?: string;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary (issue #263). Reports the render exception
 * through the crash pipeline, then shows a minimal fallback so the user
 * sees a controlled screen instead of a hard crash loop.
 */
export class CrashErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportCrash({
      kind: 'crash',
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
      route: this.props.route,
      fatal: false,
      meta: { source: 'ErrorBoundary' },
    });
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>The team has been notified. You can try again.</Text>
        <Pressable style={styles.button} onPress={this.handleReset} testID="crash-boundary-retry">
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#ffffff',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: '#555555',
    textAlign: 'center',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#1b5e20',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonLabel: {
    color: '#ffffff',
    fontWeight: '600',
  },
});
