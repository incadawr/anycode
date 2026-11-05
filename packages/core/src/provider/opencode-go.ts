// Normalized from the OpenCode Go model listing on 2026-11-05.
import type { ModelRouteSnapshot } from "./model-route.js";

export const OPENCODE_GO_MODELS = {
  "version": 1,
  "models": {
    "deepseek-v4.1-flash": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "deepseek-v4.1-flash",
          "name": "DeepSeek V4.1 Flash",
          "limit": {
            "context": 1000000,
            "output": 384000
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "high",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto",
                "none",
                "required",
                "tool"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "deepseek-v4.1-flash-opencode-go-2026-11-05",
            "input": 0.3,
            "cachedInput": 0.006,
            "output": 1.2,
            "tariff": {
              "peakUtcDays": [
                1,
                2,
                3,
                4,
                5
              ],
              "peakUtcHours": [
                [
                  1,
                  4
                ],
                [
                  6,
                  10
                ]
              ],
              "offPeakMultiplier": 0.5
            }
          }
        }
      }
    },
    "deepseek-v4-pro": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro",
          "limit": {
            "context": 1000000,
            "output": 384000
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "high",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto",
                "none",
                "required",
                "tool"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "deepseek-v4-pro-opencode-go-2026-11-05",
            "input": 1.32,
            "cachedInput": 0.044,
            "output": 3.96,
            "tariff": {
              "peakUtcDays": [
                1,
                2,
                3,
                4,
                5
              ],
              "peakUtcHours": [
                [
                  1,
                  4
                ],
                [
                  6,
                  10
                ]
              ],
              "offPeakMultiplier": 0.5
            }
          }
        }
      }
    },
    "glm-5.2": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "glm-5.2",
          "name": "GLM-5.2",
          "limit": {
            "context": 1000000,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "high",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "glm-5.2-opencode-go-2026-11-05",
            "input": 1.4,
            "cachedInput": 0.26,
            "output": 4.4
          }
        }
      }
    },
    "glm-5.3": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "glm-5.3",
          "name": "GLM-5.3",
          "limit": {
            "context": 1000000,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "high",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "glm-5.3-opencode-go-2026-11-05",
            "input": 1.4,
            "cachedInput": 0.26,
            "output": 4.4
          }
        }
      }
    },
    "grok-4.7": {
      "kind": "route",
      "route": {
        "transport": "openai-responses",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "grok-4.7",
          "name": "Grok 4.7",
          "limit": {
            "context": 500000,
            "output": 500000
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "application/pdf"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto",
                "none",
                "required",
                "tool"
              ],
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "grok-4.7-opencode-go-2026-11-05",
            "input": 2,
            "cachedInput": 0.5,
            "output": 6,
            "tiers": [
              {
                "gt": 200000,
                "input": 4,
                "cachedInput": 1,
                "output": 12
              }
            ]
          }
        }
      }
    },
    "muse-spark-1.2-contributor": {
      "kind": "route",
      "route": {
        "transport": "openai-responses",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "muse-spark-1.2-contributor",
          "name": "Muse Spark 1.2 Contributor",
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "video/mp4",
              "application/pdf",
              "audio/mpeg",
              "audio/wav"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": false,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "muse-spark-1.2-contributor-opencode-go-2026-11-05",
            "input": 0.1,
            "cachedInput": 0.002,
            "output": 0.2
          }
        }
      }
    },
    "muse-spark-1.3-contributor": {
      "kind": "route",
      "route": {
        "transport": "openai-responses",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "muse-spark-1.3-contributor",
          "name": "Muse Spark 1.3 Contributor",
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "video/mp4",
              "application/pdf",
              "audio/mpeg",
              "audio/wav"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": false,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "muse-spark-1.3-contributor-opencode-go-2026-11-05",
            "input": 0.1,
            "cachedInput": 0.002,
            "output": 0.2
          }
        }
      }
    },
    "glm-5.3-flash": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "glm-5.3-flash",
          "name": "GLM-5.3-Flash",
          "limit": {
            "context": 1000000,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "video/mp4",
              "video/x-matroska",
              "video/quicktime"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "high",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "glm-5.3-flash-opencode-go-2026-11-05",
            "input": 0.15,
            "cachedInput": 0.03,
            "output": 0.5
          }
        }
      }
    },
    "gpt-5.6-luna": {
      "kind": "route",
      "route": {
        "transport": "openai-responses",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "gpt-5.6-luna",
          "name": "GPT-5.6 Luna",
          "limit": {
            "context": 1050000,
            "input": 922000,
            "output": 128000
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "application/pdf"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": false,
            "top_p": false,
            "top_k": false,
            "system_updates": true,
            "effort_updates": true
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto",
                "none",
                "required",
                "tool"
              ],
              "search": true,
              "freeform": [
                "text",
                "lark",
                "regex"
              ],
              "updates": true
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "gpt-5.6-luna-opencode-go-2026-11-05",
            "input": 0.2,
            "cachedInput": 0.02,
            "cacheWrite": 0.25,
            "output": 1.2,
            "tiers": [
              {
                "gt": 272000,
                "input": 0.4,
                "cachedInput": 0.04,
                "cacheWrite": 0.5,
                "output": 1.8
              }
            ]
          }
        }
      }
    },
    "gpt-6-luna": {
      "kind": "route",
      "route": {
        "transport": "openai-responses",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "gpt-6-luna",
          "name": "GPT-6 Luna",
          "limit": {
            "context": 1050000,
            "input": 922000,
            "output": 128000
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "application/pdf"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": false,
            "top_p": false,
            "top_k": false,
            "system_updates": true,
            "effort_updates": true
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto",
                "none",
                "required",
                "tool"
              ],
              "search": true,
              "freeform": [
                "text",
                "lark",
                "regex"
              ],
              "updates": true
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "gpt-6-luna-opencode-go-2026-11-05",
            "input": 0.1,
            "cachedInput": 0.01,
            "cacheWrite": 0.125,
            "output": 0.5,
            "tiers": [
              {
                "gt": 272000,
                "input": 0.2,
                "cachedInput": 0.02,
                "cacheWrite": 0.25,
                "output": 0.75
              }
            ]
          }
        }
      }
    },
    "claude-haiku-5-5": {
      "kind": "route",
      "route": {
        "transport": "anthropic-messages",
        "baseUrl": "https://opencode.ai/inference/go/anthropic/v1",
        "metadata": {
          "id": "claude-haiku-5-5",
          "name": "Claude Haiku 5.5",
          "limit": {
            "context": 1000000,
            "output": 128000
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "application/pdf"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "toggle": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": false,
            "top_p": false,
            "top_k": false,
            "system_updates": true,
            "effort_updates": true
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto",
                "none",
                "required",
                "tool"
              ],
              "search": true,
              "updates": true
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "claude-haiku-5-5-opencode-go-2026-11-05",
            "input": 0.1,
            "cachedInput": 0.01,
            "cacheWrite": 0.125,
            "output": 0.5,
            "tiers": [
              {
                "gt": 100000,
                "input": 0.5,
                "cachedInput": 0.05,
                "cacheWrite": 0.625,
                "output": 2.5
              }
            ]
          }
        }
      }
    },
    "hy3": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "hy3",
          "name": "Hy3",
          "limit": {
            "context": 256000,
            "input": 192000,
            "output": 128000
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "none",
                "low",
                "high"
              ]
            },
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "hy3-opencode-go-2026-11-05",
            "input": 0.14,
            "cachedInput": 0.035,
            "output": 0.58
          }
        }
      }
    },
    "hy4-preview": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "hy4-preview",
          "name": "Hy4 preview",
          "limit": {
            "context": 1024000,
            "output": 64000
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "none",
                "high"
              ]
            },
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "hy4-preview-opencode-go-2026-11-05",
            "input": 0.834,
            "cachedInput": 0.042,
            "output": 2.501
          }
        }
      }
    },
    "kimi-k2.7-code": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "kimi-k2.7-code",
          "name": "Kimi K2.7 Code",
          "limit": {
            "context": 262144
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/bmp",
              "image/heic",
              "image/heif",
              "video/mp4",
              "video/mpeg",
              "video/mov",
              "video/avi",
              "video/x-flv",
              "video/mpg",
              "video/webm",
              "video/wmv",
              "video/3gpp"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true
            },
            "structured_output": true,
            "temperature": false,
            "top_p": false,
            "top_k": false,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto",
                "none"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "kimi-k2.7-code-opencode-go-2026-11-05",
            "input": 0.95,
            "cachedInput": 0.19,
            "output": 4
          }
        }
      }
    },
    "kimi-k3": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "kimi-k3",
          "name": "Kimi K3",
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/bmp",
              "image/heic",
              "image/heif",
              "video/mp4",
              "video/mpeg",
              "video/mov",
              "video/avi",
              "video/x-flv",
              "video/mpg",
              "video/webm",
              "video/wmv",
              "video/3gpp"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "max"
              ]
            },
            "structured_output": true,
            "temperature": false,
            "top_p": false,
            "top_k": false,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto",
                "none",
                "required"
              ],
              "updates": true
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "kimi-k3-opencode-go-2026-11-05",
            "input": 3,
            "cachedInput": 0.3,
            "cacheWrite": 3,
            "output": 15
          }
        }
      }
    },
    "mimo-v2.6-flash": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "mimo-v2.6-flash",
          "name": "MiMo-V2.6-Flash",
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/bmp",
              "audio/mpeg",
              "audio/wav",
              "audio/flac",
              "audio/mp4",
              "audio/ogg",
              "video/mp4",
              "video/quicktime",
              "video/x-msvideo",
              "video/x-ms-wmv"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true
            },
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "mimo-v2.6-flash-opencode-go-2026-11-05",
            "input": 0.14,
            "cachedInput": 0.0028,
            "output": 0.28
          }
        }
      }
    },
    "mimo-v2.6-pro": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "mimo-v2.6-pro",
          "name": "MiMo-V2.6-Pro",
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/bmp",
              "audio/mpeg",
              "audio/wav",
              "audio/flac",
              "audio/mp4",
              "audio/ogg",
              "video/mp4",
              "video/quicktime",
              "video/x-msvideo",
              "video/x-ms-wmv"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true
            },
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "mimo-v2.6-pro-opencode-go-2026-11-05",
            "input": 0.435,
            "cachedInput": 0.003625,
            "output": 0.87
          }
        }
      }
    },
    "minimax-m3": {
      "kind": "route",
      "route": {
        "transport": "anthropic-messages",
        "baseUrl": "https://opencode.ai/inference/go/anthropic/v1",
        "metadata": {
          "id": "minimax-m3",
          "name": "MiniMax-M3",
          "limit": {
            "context": 1000000,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "video/mp4",
              "video/x-msvideo",
              "video/quicktime",
              "video/x-matroska"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "toggle": true
            },
            "temperature": true,
            "top_p": true,
            "top_k": false,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto"
              ],
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "minimax-m3-opencode-go-2026-11-05",
            "input": 0.3,
            "cachedInput": 0.06,
            "output": 1.2,
            "tiers": [
              {
                "gt": 512000,
                "input": 0.6,
                "cachedInput": 0.12,
                "output": 2.4
              }
            ]
          }
        }
      }
    },
    "minimax-m3.1-flash": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "minimax-m3.1-flash",
          "name": "MiniMax M3.1 Flash",
          "limit": {
            "context": 1000000,
            "output": 512000
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "video/mp4",
              "video/x-msvideo",
              "video/quicktime",
              "video/x-matroska"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            },
            "temperature": true,
            "top_p": true,
            "top_k": false,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "minimax-m3.1-flash-opencode-go-2026-11-05",
            "input": 0.15,
            "cachedInput": 0.015,
            "output": 0.6
          }
        }
      }
    },
    "longcat-2.0": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "longcat-2.0",
          "name": "LongCat-2.0",
          "limit": {
            "context": 1000000,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "toggle": true
            },
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "longcat-2.0-opencode-go-2026-11-05",
            "input": 0.3,
            "cachedInput": 0.006,
            "output": 1.2
          }
        }
      }
    },
    "step-5-preview": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "step-5-preview",
          "name": "Step 5 Preview",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 65536
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "video/mp4",
              "video/quicktime",
              "video/x-matroska"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "step-5-preview-opencode-go-2026-11-05",
            "input": 1,
            "cachedInput": 0.1,
            "output": 2.7
          }
        }
      }
    },
    "beam-free": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "beam-free",
          "name": "Beam Free",
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto",
                "none",
                "required",
                "tool"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "beam-free-opencode-go-2026-11-05",
            "input": 0,
            "cachedInput": 0,
            "output": 0
          }
        }
      }
    },
    "qwen3.8-max": {
      "kind": "route",
      "route": {
        "transport": "anthropic-messages",
        "baseUrl": "https://opencode.ai/inference/go/anthropic/v1",
        "metadata": {
          "id": "qwen3.8-max",
          "name": "Qwen3.8 Max",
          "limit": {
            "context": 1000000,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/bmp",
              "image/jpeg",
              "image/png",
              "image/tiff",
              "image/webp",
              "image/heic",
              "video/mp4",
              "video/x-msvideo",
              "video/x-matroska",
              "video/quicktime",
              "video/x-flv",
              "video/x-ms-wmv"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "toggle": true,
              "effort": [
                "low",
                "medium",
                "xhigh"
              ],
              "budget": {
                "max": 262144
              }
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto",
                "none",
                "tool"
              ],
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "qwen3.8-max-opencode-go-2026-11-05",
            "input": 2,
            "cachedInput": 0.25,
            "cacheWrite": 2.5,
            "output": 6
          }
        }
      }
    },
    "qwen3.8-flash": {
      "kind": "route",
      "route": {
        "transport": "anthropic-messages",
        "baseUrl": "https://opencode.ai/inference/go/anthropic/v1",
        "metadata": {
          "id": "qwen3.8-flash",
          "name": "Qwen3.8 Flash",
          "limit": {
            "context": 1000000,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/bmp",
              "image/jpeg",
              "image/png",
              "image/tiff",
              "image/webp",
              "image/heic",
              "video/mp4",
              "video/x-msvideo",
              "video/x-matroska",
              "video/quicktime",
              "video/x-flv",
              "video/x-ms-wmv"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "toggle": true,
              "effort": [
                "low",
                "medium",
                "xhigh"
              ],
              "budget": {}
            },
            "structured_output": true,
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto",
                "none",
                "tool"
              ],
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "qwen3.8-flash-opencode-go-2026-11-05",
            "input": 0.15,
            "cachedInput": 0.016,
            "cacheWrite": 0.2,
            "output": 0.47
          }
        }
      }
    },
    "qwen3.7-plus": {
      "kind": "route",
      "route": {
        "transport": "anthropic-messages",
        "baseUrl": "https://opencode.ai/inference/go/anthropic/v1",
        "metadata": {
          "id": "qwen3.7-plus",
          "name": "Qwen3.7 Plus",
          "limit": {
            "context": 1000000,
            "output": 65536
          },
          "modalities": {
            "input": [
              "text",
              "image/bmp",
              "image/jpeg",
              "image/png",
              "image/tiff",
              "image/webp",
              "image/heic",
              "video/mp4",
              "video/x-msvideo",
              "video/x-matroska",
              "video/quicktime",
              "video/x-flv",
              "video/x-ms-wmv"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "toggle": true,
              "budget": {
                "max": 262144
              }
            },
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": true,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "choice": [
                "auto",
                "none",
                "tool"
              ],
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "qwen3.7-plus-opencode-go-2026-11-05",
            "input": 0.4,
            "cachedInput": 0.04,
            "cacheWrite": 0.5,
            "output": 1.6,
            "tiers": [
              {
                "gt": 256000,
                "input": 1.2,
                "cachedInput": 0.12,
                "cacheWrite": 1.5,
                "output": 4.8
              }
            ]
          }
        }
      }
    },
    "kimi-k3.1-pro": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "kimi-k3.1-pro",
          "name": "Kimi K3.1 Pro",
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/bmp",
              "image/heic",
              "image/heif",
              "video/mp4",
              "video/mpeg",
              "video/mov",
              "video/avi",
              "video/x-flv",
              "video/mpg",
              "video/webm",
              "video/wmv",
              "video/3gpp"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "default": {
                "type": "effort",
                "value": "max"
              },
              "effort": [
                "low",
                "high",
                "max"
              ]
            },
            "structured_output": true,
            "temperature": false,
            "top_p": false,
            "top_k": false,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "strict": true,
              "choice": [
                "auto",
                "none",
                "required"
              ],
              "updates": false
            }
          },
          "compatibility": {
            "reasoning_field": "reasoning_content"
          },
          "pricing": {
            "basisId": "kimi-k3.1-pro-opencode-go-2026-11-05",
            "input": 2,
            "cachedInput": 0.2,
            "cacheWrite": 2,
            "output": 10
          }
        }
      }
    },
    "iceman-contributor-free": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "iceman-contributor-free",
          "name": "Iceman Contributor Free",
          "limit": {
            "context": 262144,
            "output": 131072
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true
            },
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "iceman-contributor-free-opencode-go-2026-11-05",
            "input": 0,
            "cachedInput": 0,
            "output": 0
          }
        }
      }
    },
    "hy4": {
      "kind": "route",
      "route": {
        "transport": "openai-chat-completions",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "metadata": {
          "id": "hy4",
          "name": "Hy4",
          "limit": {
            "context": 1048576,
            "input": 983010,
            "output": 65536
          },
          "modalities": {
            "input": [
              "text",
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/gif"
            ],
            "output": [
              "text"
            ]
          },
          "capabilities": {
            "tools": {
              "supported": true
            },
            "reasoning": {
              "supported": true,
              "effort": [
                "none",
                "high"
              ]
            },
            "temperature": true,
            "top_p": true,
            "top_k": true,
            "system_updates": false,
            "effort_updates": false
          },
          "apiCapabilities": {
            "tools": {
              "updates": false
            }
          },
          "compatibility": {},
          "pricing": {
            "basisId": "hy4-opencode-go-2026-11-05",
            "input": 0.834,
            "cachedInput": 0.042,
            "output": 2.501
          }
        }
      }
    }
  }
} as const satisfies ModelRouteSnapshot<unknown>;
