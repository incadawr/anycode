export function providerProxyConfig(rules) {
  return { mode: "fixed_servers", proxyRules: rules, proxyBypassRules: "<-loopback>" };
}
