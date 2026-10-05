-- Oracle for the dog-size and line-pricing rules exactly as they stood before
-- SB-03 (20261019110000 / 20261020120000), plus a wrapper over the new resolver.
-- Session-scoped (pg_temp); included with \ir by size_band_smoke.sql and
-- size_band_upgrade_checks.sql so both prove equivalence against the same oracle.
-- Both return '' on missing data and 'ERR:<sqlstate>:<message>' on errors.
create function pg_temp.old_dog_size(p_org uuid, p_weight numeric) returns text language plpgsql stable as $$
declare v_xs numeric := 5; v_s numeric := 10; v_m numeric := 15; v_l numeric := 25;
begin
  if p_weight is null or p_weight<=0 then return null; end if;
  select xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg into v_xs,v_s,v_m,v_l
    from public.organization_dog_size_boundaries where organization_id=p_org;
  if not found then v_xs:=5; v_s:=10; v_m:=15; v_l:=25; end if;
  return case when p_weight<v_xs then 'extra_small' when p_weight<v_s then 'small'
    when p_weight<v_m then 'medium' when p_weight<=v_l then 'large' else 'extra_large' end;
end $$;

create function pg_temp.old_line(p_org uuid,p_service uuid,p_species text,p_weight numeric,p_size text,p_qty integer)
returns text language plpgsql stable as $$
declare v_size text := p_size; sc record; v_sp numeric; v_sd integer; v_price numeric; v_src text; v_dur integer;
begin
  if p_species='cat' then v_size:='cat';
  elsif p_species='dog' then v_size:=coalesce(pg_temp.old_dog_size(p_org,p_weight),v_size);
  else v_size:=p_species; end if;
  select * into sc from public.service_catalog where organization_id=p_org and id=p_service and is_active and deleted_at is null;
  if not found then raise exception 'service_not_active_or_not_in_org' using errcode='check_violation'; end if;
  v_sp := case v_size when 'extra_small' then sc.price_extra_small when 'small' then sc.price_small when 'medium' then sc.price_medium
    when 'large' then sc.price_large when 'extra_large' then sc.price_extra_large when 'cat' then sc.price_cat
    else (sc.species_pricing->p_species->>'price')::numeric end;
  v_sd := case v_size when 'extra_small' then sc.duration_extra_small when 'small' then sc.duration_small when 'medium' then sc.duration_medium
    when 'large' then sc.duration_large when 'extra_large' then sc.duration_extra_large when 'cat' then sc.duration_cat
    else (sc.species_pricing->p_species->>'duration')::integer end;
  if p_species not in ('dog','cat') and v_sp is null then raise exception 'species_price_not_configured' using errcode='22023'; end if;
  if v_size is not null and v_sp is not null then v_price:=v_sp; v_src:='size_matrix'; else v_price:=coalesce(sc.base_price,0); v_src:='base'; end if;
  v_dur := coalesce(v_sd,sc.duration_minutes,60)+coalesce(sc.additional_duration_minutes,0)*greatest(p_qty-1,0);
  return coalesce(v_size,'')||'|'||v_price||'|'||v_dur||'|'||v_src;
exception when others then return 'ERR:'||sqlstate||':'||sqlerrm;
end $$;
create function pg_temp.new_line(p_org uuid,p_service uuid,p_species text,p_weight numeric,p_size text,p_qty integer)
returns text language plpgsql stable as $$
declare r record;
begin
  select * into r from app.resolve_service_line(p_org,p_service,p_species,p_weight,p_size,p_qty);
  return coalesce(r.pricing_key,'')||'|'||r.unit_price||'|'||r.duration||'|'||r.price_source;
exception when others then return 'ERR:'||sqlstate||':'||sqlerrm;
end $$;
