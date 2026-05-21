import os

from opentelemetry import trace  # pyright: ignore[reportMissingTypeStubs]
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter,  # pyright: ignore[reportMissingTypeStubs]
)
from opentelemetry.sdk.resources import Resource  # pyright: ignore[reportMissingTypeStubs]
from opentelemetry.sdk.trace import TracerProvider  # pyright: ignore[reportMissingTypeStubs]
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,  # pyright: ignore[reportMissingTypeStubs]
)


def configure_tracing(service_name: str = "content_tool") -> None:
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        # No collector → no-op
        return
    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")))
    trace.set_tracer_provider(provider)
