import Document, { Head, Html, Main, NextScript, type DocumentContext } from "next/document";
import { DEFAULT_LOCALE, normalizeLocale } from "../lib/i18n";

export default class MarketingDocument extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    return Document.getInitialProps(ctx);
  }

  render() {
    const locale = normalizeLocale(this.props.locale || DEFAULT_LOCALE);
    return (
      <Html lang={locale}>
        <Head>
          {/* Favicons & app icons */}
          <link rel="icon" href="/favicon.ico" sizes="any" />
          <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
          <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          <link rel="manifest" href="/site.webmanifest" />
          <meta name="theme-color" content="#071018" />

          {/* Default social share metadata (pages may override og:title/description) */}
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="Nora" />
          <meta property="og:title" content="Nora — Self-hosted OpenClaw & Hermes control plane" />
          <meta
            property="og:description"
            content="Deploy, monitor, and operate OpenClaw and Hermes AI agent fleets on Docker or Kubernetes with Nora's open-source control plane, REST API, CLI, and MCP server."
          />
          <meta property="og:url" content="https://nora.solomontsao.com/" />
          <meta property="og:image" content="https://nora.solomontsao.com/og-image.png" />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content="Nora self-hosted AI agent control plane" />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content="Nora — Self-hosted OpenClaw & Hermes control plane" />
          <meta
            name="twitter:description"
            content="Deploy and operate OpenClaw and Hermes fleets on Docker or Kubernetes with Nora's open-source control plane."
          />
          <meta name="twitter:image" content="https://nora.solomontsao.com/og-image.png" />
          <meta name="twitter:image:alt" content="Nora self-hosted AI agent control plane" />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
