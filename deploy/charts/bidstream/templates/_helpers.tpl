{{/* Container env shared by every track of a service. Args: dict root name svc version extraEnv */}}
{{- define "bidstream.env" -}}
{{- $svc := .svc -}}
{{- if $svc.database }}
- name: DB_USER
  valueFrom: { secretKeyRef: { name: {{ .root.Values.databaseSecret }}, key: username } }
- name: DB_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .root.Values.databaseSecret }}, key: password } }
- name: DATABASE_URL
  value: "postgresql://$(DB_USER):$(DB_PASSWORD)@{{ .root.Values.databaseHost }}/{{ $svc.database }}"
{{- end }}
{{- if ne (toString $svc.kafka) "false" }}
- name: KAFKA_BROKERS
  value: {{ .root.Values.kafkaBrokers | quote }}
{{- end }}
{{- if ne (toString $svc.tracing) "false" }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .root.Values.otelEndpoint | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ .name | quote }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "service.version={{ .version }}"
# The edge decides whether a request is traced and every hop follows it, so
# sampled traces stay complete.
- name: OTEL_TRACES_SAMPLER
  value: parentbased_traceidratio
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ .root.Values.traceSampleRatio | quote }}
{{- end }}
- name: LOG_LEVEL
  value: info
{{- range $k, $v := merge (deepCopy (.extraEnv | default dict)) ($svc.env | default dict) }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{/* One Deployment (+ PDB) for a service track. Args: dict root name svc version replicas extraEnv */}}
{{- define "bidstream.deployment" -}}
{{- $svc := .svc -}}
{{- $root := .root -}}
{{- $fullname := ternary .name (printf "%s-%s" .name .version) (eq .version "") -}}
{{- $version := .version | default "v1" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $fullname }}
  labels: { app: {{ .name }}, version: {{ $version }} }
spec:
  replicas: {{ .replicas }}
  selector:
    matchLabels: { app: {{ .name }}, version: {{ $version }} }
  template:
    metadata:
      labels: { app: {{ .name }}, version: {{ $version }} }
    spec:
      serviceAccountName: {{ .name }}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app: {{ .name }}, version: {{ $version }} }
      terminationGracePeriodSeconds: 20
      containers:
        - name: {{ .name }}
          image: "{{ $root.Values.image.registry }}/{{ .name }}:{{ $root.Values.image.tag }}"
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          ports:
            - name: {{ $svc.protocol }}
              containerPort: {{ $svc.port }}
          env:
            {{- include "bidstream.env" (dict "root" $root "name" .name "svc" $svc "version" $version "extraEnv" .extraEnv) | trim | nindent 12 }}
          {{- if eq $svc.protocol "grpc" }}
          readinessProbe:
            grpc: { port: {{ $svc.port }} }
            periodSeconds: 5
          livenessProbe:
            grpc: { port: {{ $svc.port }} }
            initialDelaySeconds: 20
            periodSeconds: 10
          {{- else }}
          readinessProbe:
            httpGet: { path: {{ $svc.probes.readiness }}, port: {{ $svc.port }} }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: {{ $svc.probes.liveness }}, port: {{ $svc.port }} }
            initialDelaySeconds: 10
            periodSeconds: 10
          {{- end }}
          resources: {{- toYaml ($svc.resources | default $root.Values.defaults.resources) | nindent 12 }}
          {{- if ne (toString $svc.hardened) "false" }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
            seccompProfile: { type: RuntimeDefault }
          {{- end }}
{{- if gt (int .replicas) 1 }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $fullname }}
spec:
  minAvailable: 1
  selector:
    matchLabels: { app: {{ .name }}, version: {{ $version }} }
{{- end }}
{{- end -}}
