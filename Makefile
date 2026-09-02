
clean:
	rm -rf ./__pycache__ ./api/__pycache__ ./client/__pycache__ ./mpg/__pycache__

run:
	flask run --host=0.0.0.0
