{
  "targets": [
    {
      "target_name": "durability",
      "sources": ["native/durability.cc"],
      "defines": ["NAPI_VERSION=8"],
      "cflags_cc": ["-std=c++20"],
      "conditions": [
        ["OS=='win'", {
          "defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN"]
        }]
      ]
    }
  ]
}
