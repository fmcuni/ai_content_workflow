from fastapi import FastAPI

from content_tool.api.routes.runs import router as runs_router


def create_app() -> FastAPI:
    app = FastAPI(title="Bowtie AI Content Tool", version="0.1.0")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(runs_router)
    return app


app = create_app()
