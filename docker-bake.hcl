variable "REGISTRY_IMAGE" {
  default = "tg-emby-notify"
}

variable "PYTHON_VERSION" {
  default = "3.12"
}

variable "VERSION" {
  default = "1.1.6"
}

group "default" {
  targets = ["alpine", "slim"]
}

target "base" {
  dockerfile = "Dockerfile"
  context = "."
  attest = [
    "type=sbom,disabled=true",
    "type=provenance,disabled=true"
  ]
  args = {
    PYTHON_VERSION = PYTHON_VERSION
  }
  platforms = [
    "linux/amd64",
    "linux/arm64"
  ]
}

target "alpine" {
  inherits = ["base"]
  target = "runtime-alpine"
  tags = [
    "${REGISTRY_IMAGE}:latest",
    "${REGISTRY_IMAGE}:alpine",
    "${REGISTRY_IMAGE}:${VERSION}",
    "${REGISTRY_IMAGE}:${VERSION}-alpine"
  ]
}

target "slim" {
  inherits = ["base"]
  target = "runtime-slim"
  tags = [
    "${REGISTRY_IMAGE}:slim",
    "${REGISTRY_IMAGE}:${VERSION}-slim"
  ]
}
