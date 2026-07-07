FROM python:3.13-slim

WORKDIR /srv

COPY cloud/container/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# app.py resolves _REPO_ROOT as three directories up from its own file location
# (mirroring cloud/container/app.py inside the real repo checkout), then imports
# pdf2fxl from <_REPO_ROOT>/src and loads the base font from <_REPO_ROOT>/assets.
# Preserve that exact relative depth so nothing needs to change at runtime.
COPY src/ /srv/src/
COPY assets/ /srv/assets/
COPY cloud/container/app.py /srv/cloud/container/app.py
COPY cloud/container/enrich.py /srv/cloud/container/enrich.py

WORKDIR /srv/cloud/container
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
