FROM python:3.13-slim

WORKDIR /srv

COPY cloud/container/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY cloud/container/app.py ./app.py

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
