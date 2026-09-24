declare const process: {
  env: {
    EXPO_PUBLIC_API_URL?: string;
    EXPO_PUBLIC_API_VERSION_PREFIX?: string;
    EXPO_PUBLIC_ANALYTICS_ENABLED?: string;
    EXPO_PUBLIC_STELLAR_NETWORK?: string;
    EXPO_PUBLIC_PUSH_PROVIDER?: string;
    EXPO_PUBLIC_CRASH_INGEST_URL?: string;
    EXPO_PUBLIC_SENTRY_DSN?: string;
    EXPO_PUBLIC_CRASH_RELEASE?: string;
    EXPO_PUBLIC_APP_VERSION?: string;
    [key: string]: string | undefined;
  };
};
