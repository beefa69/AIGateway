-- Cost of Switchyard's own routing-time calls (the judge) for this request.
ALTER TABLE requests ADD COLUMN router_cost_usd REAL;
